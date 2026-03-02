import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Repository } from "../api/lib/index.js";

const mocks = vi.hoisted(() => ({
  loadRepositoryConfig: vi.fn(),
  createPROperations: vi.fn(),
  getRepoDiscussionInfo: vi.fn(),
  findOrCreateColonyJournal: vi.fn(),
  addStandupComment: vi.fn(),
  getLastStandupDate: vi.fn(),
  computeDayNumber: vi.fn(),
  collectStandupData: vi.fn(),
  formatStandupComment: vi.fn(),
  generateStandupLLMContent: vi.fn(),
  hasAnyContent: vi.fn(),
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    group: vi.fn(),
    groupEnd: vi.fn(),
  },
}));

vi.mock("../api/lib/index.js", () => ({
  loadRepositoryConfig: (...args: unknown[]) => mocks.loadRepositoryConfig(...args),
  createPROperations: (...args: unknown[]) => mocks.createPROperations(...args),
  logger: mocks.logger,
}));

vi.mock("../api/lib/discussions.js", () => ({
  getRepoDiscussionInfo: (...args: unknown[]) => mocks.getRepoDiscussionInfo(...args),
  findOrCreateColonyJournal: (...args: unknown[]) => mocks.findOrCreateColonyJournal(...args),
  addStandupComment: (...args: unknown[]) => mocks.addStandupComment(...args),
  getLastStandupDate: (...args: unknown[]) => mocks.getLastStandupDate(...args),
  computeDayNumber: (...args: unknown[]) => mocks.computeDayNumber(...args),
}));

vi.mock("../api/lib/standup.js", () => ({
  collectStandupData: (...args: unknown[]) => mocks.collectStandupData(...args),
  formatStandupComment: (...args: unknown[]) => mocks.formatStandupComment(...args),
  generateStandupLLMContent: (...args: unknown[]) => mocks.generateStandupLLMContent(...args),
  hasAnyContent: (...args: unknown[]) => mocks.hasAnyContent(...args),
}));

import { processRepository } from "./daily-standup.js";

const testRepo: Repository = {
  owner: { login: "hivemoot" },
  name: "hivemoot-bot",
  full_name: "hivemoot/hivemoot-bot",
};

const testOctokit = {} as never;
const testAppId = 77;
const reportDate = "2026-03-01";

const configEnabled = {
  standup: { enabled: true, category: "Colony Reports" },
};

const discussionInfo = {
  repoId: "R_kgDOA1",
  repoCreatedAt: "2026-01-01T00:00:00Z",
  hasDiscussions: true,
  categories: [{ id: "DIC_123", name: "Colony Reports" }],
};

const journal = { discussionId: "D_kwDO123", number: 12 };
const standupData = {
  discussionPhase: [],
  votingPhase: [],
  extendedVoting: [],
  readyToImplement: [],
  repoFullName: "hivemoot/hivemoot-bot",
  reportDate,
  dayNumber: 60,
};

describe("daily-standup processRepository", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-02T00:05:00Z"));
    vi.clearAllMocks();

    mocks.loadRepositoryConfig.mockResolvedValue(configEnabled);
    mocks.getRepoDiscussionInfo.mockResolvedValue(discussionInfo);
    mocks.findOrCreateColonyJournal.mockResolvedValue(journal);
    mocks.getLastStandupDate.mockResolvedValue("2026-02-28");
    mocks.computeDayNumber.mockReturnValue(60);
    mocks.createPROperations.mockReturnValue({ findPRsWithLabel: vi.fn() });
    mocks.collectStandupData.mockResolvedValue(standupData);
    mocks.hasAnyContent.mockReturnValue(true);
    mocks.generateStandupLLMContent.mockResolvedValue("narrative");
    mocks.formatStandupComment.mockReturnValue("formatted standup");
    mocks.addStandupComment.mockResolvedValue({ commentId: "x", url: "https://example.test/c/1" });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("skips when repo config is missing", async () => {
    mocks.loadRepositoryConfig.mockResolvedValue(null);

    await processRepository(testOctokit, testRepo, testAppId);

    expect(mocks.logger.debug).toHaveBeenCalledWith(
      "No config file found for hivemoot/hivemoot-bot; skipping standup"
    );
    expect(mocks.getRepoDiscussionInfo).not.toHaveBeenCalled();
    expect(mocks.logger.groupEnd).toHaveBeenCalledTimes(1);
  });

  it("skips when standup is disabled", async () => {
    mocks.loadRepositoryConfig.mockResolvedValue({
      standup: { enabled: false, category: "Colony Reports" },
    });

    await processRepository(testOctokit, testRepo, testAppId);

    expect(mocks.logger.debug).toHaveBeenCalledWith(
      "Standup not enabled for hivemoot/hivemoot-bot"
    );
    expect(mocks.getRepoDiscussionInfo).not.toHaveBeenCalled();
    expect(mocks.logger.groupEnd).toHaveBeenCalledTimes(1);
  });

  it("skips when discussions are not enabled", async () => {
    mocks.getRepoDiscussionInfo.mockResolvedValue({
      ...discussionInfo,
      hasDiscussions: false,
    });

    await processRepository(testOctokit, testRepo, testAppId);

    expect(mocks.logger.debug).toHaveBeenCalledWith(
      "Discussions not enabled for hivemoot/hivemoot-bot"
    );
    expect(mocks.findOrCreateColonyJournal).not.toHaveBeenCalled();
    expect(mocks.logger.groupEnd).toHaveBeenCalledTimes(1);
  });

  it("warns and exits when configured discussion category is missing", async () => {
    mocks.getRepoDiscussionInfo.mockResolvedValue({
      ...discussionInfo,
      categories: [{ id: "DIC_999", name: "Other Category" }],
    });

    await processRepository(testOctokit, testRepo, testAppId);

    expect(mocks.logger.warn).toHaveBeenCalledWith(
      '[hivemoot/hivemoot-bot] Discussion category "Colony Reports" not found. ' +
      "Create this category in Settings → Discussions, or set standup.category in .github/hivemoot.yml."
    );
    expect(mocks.findOrCreateColonyJournal).not.toHaveBeenCalled();
    expect(mocks.logger.groupEnd).toHaveBeenCalledTimes(1);
  });

  it("skips when today's report is already posted", async () => {
    mocks.getLastStandupDate.mockResolvedValue(reportDate);

    await processRepository(testOctokit, testRepo, testAppId);

    expect(mocks.logger.info).toHaveBeenCalledWith(
      "[hivemoot/hivemoot-bot] Today's standup already posted, skipping"
    );
    expect(mocks.computeDayNumber).not.toHaveBeenCalled();
    expect(mocks.addStandupComment).not.toHaveBeenCalled();
    expect(mocks.logger.groupEnd).toHaveBeenCalledTimes(1);
  });

  it("runs full pipeline and posts standup with LLM content", async () => {
    await processRepository(testOctokit, testRepo, testAppId, { installationId: 456 });

    expect(mocks.loadRepositoryConfig).toHaveBeenCalledWith(
      testOctokit,
      "hivemoot",
      "hivemoot-bot"
    );
    expect(mocks.getRepoDiscussionInfo).toHaveBeenCalledWith(
      testOctokit,
      "hivemoot",
      "hivemoot-bot"
    );
    expect(mocks.findOrCreateColonyJournal).toHaveBeenCalledWith(
      testOctokit,
      discussionInfo.repoId,
      "DIC_123",
      "hivemoot",
      "hivemoot-bot"
    );
    expect(mocks.getLastStandupDate).toHaveBeenCalledWith(
      testOctokit,
      "hivemoot",
      "hivemoot-bot",
      journal.number
    );
    expect(mocks.computeDayNumber).toHaveBeenCalledWith(
      discussionInfo.repoCreatedAt,
      reportDate
    );
    expect(mocks.createPROperations).toHaveBeenCalledWith(testOctokit, { appId: testAppId });
    expect(mocks.collectStandupData).toHaveBeenCalledWith(
      testOctokit,
      expect.any(Object),
      "hivemoot",
      "hivemoot-bot",
      reportDate,
      60
    );
    expect(mocks.generateStandupLLMContent).toHaveBeenCalledWith(standupData, {
      installationId: 456,
    });
    expect(mocks.formatStandupComment).toHaveBeenCalledWith(standupData, "narrative");
    expect(mocks.addStandupComment).toHaveBeenCalledWith(
      testOctokit,
      journal.discussionId,
      "formatted standup",
      "hivemoot",
      "hivemoot-bot",
      journal.number,
      reportDate
    );
    expect(mocks.logger.info).toHaveBeenCalledWith(
      "[hivemoot/hivemoot-bot] Posted Colony Report — Day 60 (https://example.test/c/1)"
    );
    expect(mocks.logger.groupEnd).toHaveBeenCalledTimes(1);
  });

  it("skips LLM generation when standup has no content", async () => {
    mocks.hasAnyContent.mockReturnValue(false);

    await processRepository(testOctokit, testRepo, testAppId, { installationId: 456 });

    expect(mocks.generateStandupLLMContent).not.toHaveBeenCalled();
    expect(mocks.formatStandupComment).toHaveBeenCalledWith(standupData, null);
    expect(mocks.addStandupComment).toHaveBeenCalledTimes(1);
    expect(mocks.logger.groupEnd).toHaveBeenCalledTimes(1);
  });

  it("logs verified fallback when comment URL is missing", async () => {
    mocks.addStandupComment.mockResolvedValue({ commentId: "x", url: "" });

    await processRepository(testOctokit, testRepo, testAppId);

    expect(mocks.logger.info).toHaveBeenCalledWith(
      "[hivemoot/hivemoot-bot] Posted Colony Report — Day 60 (verified)"
    );
    expect(mocks.logger.groupEnd).toHaveBeenCalledTimes(1);
  });

  it("always ends logger group when a step throws", async () => {
    const boom = new Error("collect failed");
    mocks.collectStandupData.mockRejectedValue(boom);

    await expect(
      processRepository(testOctokit, testRepo, testAppId, { installationId: 456 })
    ).rejects.toThrow("collect failed");
    expect(mocks.logger.groupEnd).toHaveBeenCalledTimes(1);
  });
});
