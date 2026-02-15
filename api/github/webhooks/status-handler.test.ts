import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  return {
    createPROperations: vi.fn(),
    loadRepositoryConfig: vi.fn(),
    evaluateMergeReadiness: vi.fn(),
    prOps: {},
  };
});

vi.mock("probot", () => ({
  createProbot: vi.fn(() => ({})),
  createNodeMiddleware: vi.fn(() => vi.fn()),
}));

vi.mock("../../lib/env-validation.js", () => ({
  validateEnv: vi.fn(() => ({ valid: true, missing: [] })),
  getAppId: vi.fn(() => 12345),
}));

vi.mock("../../lib/index.js", () => ({
  createIssueOperations: vi.fn(),
  createPROperations: mocks.createPROperations,
  createRepositoryLabelService: vi.fn(),
  createGovernanceService: vi.fn(),
  loadRepositoryConfig: mocks.loadRepositoryConfig,
  getOpenPRsForIssue: vi.fn(),
  evaluateMergeReadiness: mocks.evaluateMergeReadiness,
}));

vi.mock("../../lib/graphql-queries.js", () => ({
  getLinkedIssues: vi.fn(),
}));

vi.mock("../../lib/implementation-intake.js", () => ({
  processImplementationIntake: vi.fn(),
  recalculateLeaderboardForPR: vi.fn(),
}));

import { app as registerWebhookApp } from "./index.js";

type WebhookHandler = (context: unknown) => Promise<void> | void;

function createWebhookHarness() {
  const handlers = new Map<string, WebhookHandler>();
  const probotApp = {
    log: {
      info: vi.fn(),
      error: vi.fn(),
    },
    on: vi.fn((event: string | string[], handler: WebhookHandler) => {
      if (Array.isArray(event)) {
        for (const entry of event) {
          handlers.set(entry, handler);
        }
        return;
      }
      handlers.set(event, handler);
    }),
  };

  registerWebhookApp(probotApp as any);
  return { handlers };
}

function createStatusContext(options?: {
  sha?: string;
  pullRequests?: Array<{ number: number; head: { sha: string } }>;
}) {
  const sha = options?.sha ?? "abc123";
  const pullRequests = options?.pullRequests ?? [];

  return {
    payload: {
      sha,
      repository: {
        owner: { login: "hivemoot" },
        name: "hivemoot-bot",
        full_name: "hivemoot/hivemoot-bot",
      },
    },
    octokit: {
      rest: {
        pulls: {
          list: vi.fn().mockResolvedValue({ data: pullRequests }),
        },
      },
    },
    log: {
      info: vi.fn(),
      error: vi.fn(),
    },
  };
}

describe("status webhook handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createPROperations.mockReturnValue(mocks.prOps);
    mocks.loadRepositoryConfig.mockResolvedValue({
      governance: {
        pr: {
          mergeReady: {
            requiredApprovals: 1,
          },
          trustedReviewers: ["hivemoot-builder"],
        },
      },
    });
  });

  it("skips processing when merge-ready config is disabled", async () => {
    const { handlers } = createWebhookHarness();
    const handler = handlers.get("status");
    expect(handler).toBeDefined();

    mocks.loadRepositoryConfig.mockResolvedValueOnce({
      governance: {
        pr: {
          mergeReady: null,
          trustedReviewers: [],
        },
      },
    });

    const context = createStatusContext({
      pullRequests: [{ number: 11, head: { sha: "abc123" } }],
    });

    await handler!(context);

    expect(context.octokit.rest.pulls.list).not.toHaveBeenCalled();
    expect(mocks.evaluateMergeReadiness).not.toHaveBeenCalled();
  });

  it("evaluates merge-readiness only for pull requests matching the status SHA", async () => {
    const { handlers } = createWebhookHarness();
    const handler = handlers.get("status");
    expect(handler).toBeDefined();

    const context = createStatusContext({
      sha: "abc123",
      pullRequests: [
        { number: 11, head: { sha: "abc123" } },
        { number: 12, head: { sha: "def456" } },
        { number: 13, head: { sha: "abc123" } },
      ],
    });

    await handler!(context);

    expect(context.octokit.rest.pulls.list).toHaveBeenCalledWith({
      owner: "hivemoot",
      repo: "hivemoot-bot",
      state: "open",
      sort: "updated",
      direction: "desc",
      per_page: 100,
    });
    expect(mocks.evaluateMergeReadiness).toHaveBeenCalledTimes(2);
    expect(mocks.evaluateMergeReadiness).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        ref: { owner: "hivemoot", repo: "hivemoot-bot", prNumber: 11 },
        headSha: "abc123",
      })
    );
    expect(mocks.evaluateMergeReadiness).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        ref: { owner: "hivemoot", repo: "hivemoot-bot", prNumber: 13 },
        headSha: "abc123",
      })
    );
  });

  it("aggregates per-PR merge-readiness failures", async () => {
    const { handlers } = createWebhookHarness();
    const handler = handlers.get("status");
    expect(handler).toBeDefined();

    mocks.evaluateMergeReadiness
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("review API unavailable"));

    const context = createStatusContext({
      sha: "abc123",
      pullRequests: [
        { number: 11, head: { sha: "abc123" } },
        { number: 13, head: { sha: "abc123" } },
      ],
    });

    await expect(handler!(context)).rejects.toThrow(
      "1 PR(s) failed merge-readiness evaluation after status event"
    );

    expect(context.log.error).toHaveBeenCalledWith(
      expect.objectContaining({
        pr: 13,
        repo: "hivemoot/hivemoot-bot",
      }),
      "Failed to evaluate merge-readiness after status event"
    );
  });
});
