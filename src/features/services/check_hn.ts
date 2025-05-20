import { CronJob } from "cron";
import * as Sentry from "@sentry/bun";
import { db, environment } from "../../index";
import {
  users as usersTable,
  stories as storiesTable,
  leaderboardSnapshots,
} from "../../libs/schema";
import { eq, and, isNull, lt, gte, notInArray, not, count } from "drizzle-orm";
import {
  getNewStories,
  getItems,
  type Story,
} from "../../libs/hackernews";
import { addDays } from "../../libs/time";
import type { AnyMessageBlock } from "slack-edge";

// Constants
const TOP_STORIES_LIMIT = 30; // Front page is considered the top 30 stories
const RETENTION_DAYS = 5; // Keep non-verified user stories for 5 days
const CHECK_INTERVAL = "*/5 * * * *"; // Check every 5 minutes

/**
 * Calculate the expiration timestamp for a story
 * @returns timestamp in seconds (null for verified user stories)
 */
function calculateExpirationTime(isFromVerifiedUser: boolean): number | null {
  if (isFromVerifiedUser) {
    return null; // Stories from verified users are kept indefinitely
  }

  // Add RETENTION_DAYS to current timestamp (in seconds)
  return Math.floor(addDays(new Date(), RETENTION_DAYS).getTime() / 1000);
}

/**
 * Process stories from HackerNews - handles both new and top stories
 */
async function processStories() {
  try {
    console.log("Fetching HackerNews stories...");

    // Get all verified users from our database
    const verifiedUsers = await db
      .select()
      .from(usersTable)
      .where(eq(usersTable.verified, true));

    // Create a map of verified HN usernames for quick lookup (case insensitive)
    const verifiedUserMap = new Map<string, (typeof verifiedUsers)[0]>(
      verifiedUsers
        .map((user) =>
          user.hackernewsUsername
            ? ([user.hackernewsUsername.toLowerCase(), user] as [
                string,
                typeof user,
              ])
            : null,
        )
        .filter(
          (entry): entry is [string, (typeof verifiedUsers)[0]] =>
            entry !== null,
        ),
    );

    // Fetch the latest stories - position in array determines leaderboard position
    // Only one API call to get new stories instead of separate calls for new and top stories
    const storyIds = await getNewStories();
    if (!storyIds.length) {
      console.log("No stories found");
      return;
    }

    console.log(`Processing ${storyIds.length} stories`);

    // Front page is considered the top stories
    const frontPageIds = storyIds.slice(0, TOP_STORIES_LIMIT);
    
    // Batch fetch story details - limit to first 500 to avoid overloading
    const stories = await getItems<Story>(storyIds.slice(0, 500));

    // Get current timestamp in seconds
    const currentTime = Math.floor(Date.now() / 1000);

    // Process each story
    for (let i = 0; i < stories.length; i++) {
      const story = stories[i];
      const position = i + 1; // Position is 1-based, matching index in the feed
      const isOnFrontPage = position <= TOP_STORIES_LIMIT;
      const isNumberOne = position === 1;
      if (!story || !story.by || story.type !== "story") continue;

      const storyAuthor = story.by.toLowerCase();
      const isFromVerifiedUser = verifiedUserMap.has(storyAuthor);
      const isOnLeaderboard = isOnFrontPage;

      // Check if story already exists in our database
      const existingStory = await db
        .select()
        .from(storiesTable)
        .where(eq(storiesTable.id, story.id))
        .then((a) => a[0]);

      if (!existingStory) {
        // New story - add to database
        const expiresAt = calculateExpirationTime(isFromVerifiedUser);

        // Create notification tracking fields
        const notifiedFrontPage = isOnLeaderboard && (isFromVerifiedUser || isNumberOne);
        const notifiedNumberOne = isNumberOne && isFromVerifiedUser;
        const notifiedNewStory = isFromVerifiedUser;

        await db.insert(storiesTable).values({
          id: story.id,
          by: story.by,
          title: story.title,
          url: story.url,
          text: story.text,
          time: story.time,
          score: story.score,
          descendants: story.descendants,
          firstSeenAt: currentTime,
          lastUpdatedAt: currentTime,
          // Track when first notification was sent (if any)
          notifiedAt: (notifiedFrontPage || notifiedNumberOne || notifiedNewStory) ? currentTime : null,
          // Track specific notification types
          notifiedNewStory: notifiedNewStory,
          notifiedFrontPage: notifiedFrontPage,
          notifiedNumberOne: notifiedNumberOne,
          isOnLeaderboard: isOnLeaderboard,
          enteredLeaderboardAt: isOnLeaderboard ? currentTime : null,
          position: position,
          peakPosition: isOnLeaderboard ? position : null,
          peakPositionAt: isOnLeaderboard ? currentTime : null,
          peakScore: story.score,
          peakScoreAt: currentTime,
          isFromMonitoredUser: isFromVerifiedUser,
          expiresAt: expiresAt,
        });

        // Record leaderboard snapshot if on leaderboard
        if (isOnLeaderboard) {
          await recordLeaderboardSnapshot({
            storyId: story.id,
            position,
            score: story.score,
            timestamp: currentTime,
            isFromVerifiedUser,
            expiresAt,
          });
        }

        // Send notifications
        if (isFromVerifiedUser) {
          if (isNumberOne) {
            await sendNotification(story, "number_one_story");
          } else if (isOnLeaderboard) {
            await sendNotification(story, "front_page_story");
          } else {
            await sendNotification(story, "new_story_by_verified_user");
          }
        }
      } else {
        // Existing story - update stats
        const storyUpdates: Partial<typeof storiesTable.$inferSelect> = {
          score: story.score,
          descendants: story.descendants,
          position: position,
          lastUpdatedAt: currentTime,
          isFromMonitoredUser: isFromVerifiedUser || existingStory.isFromMonitoredUser,
        };

        // Record leaderboard snapshot if on leaderboard
        if (isOnLeaderboard) {
          await recordLeaderboardSnapshot({
            storyId: story.id,
            position,
            score: story.score,
            timestamp: currentTime,
            isFromVerifiedUser,
            expiresAt: calculateExpirationTime(isFromVerifiedUser),
          });
        }

        let shouldSendNotification = false;
        let notificationType: "new_story_by_verified_user" | "front_page_story" | "number_one_story" = "new_story_by_verified_user";

        // Handle leaderboard status changes
        if (isOnLeaderboard) {
          if (!existingStory.isOnLeaderboard) {
            // Just entered leaderboard
            storyUpdates.isOnLeaderboard = true;
            storyUpdates.enteredLeaderboardAt = currentTime;
            storyUpdates.peakPosition = position;
            storyUpdates.peakPositionAt = currentTime;
            storyUpdates.peakScore = story.score;
            storyUpdates.peakScoreAt = currentTime;

            // Notify if from verified user and no front page notification yet
            if (isFromVerifiedUser && !existingStory.notifiedFrontPage) {
              storyUpdates.notifiedFrontPage = true;
              storyUpdates.notifiedAt = existingStory.notifiedAt || currentTime;
              shouldSendNotification = true;
              notificationType = "front_page_story";
            }
          } else {
            // Already on leaderboard - update peak stats if better
            if (position < (existingStory.peakPosition || Number.POSITIVE_INFINITY)) {
              storyUpdates.peakPosition = position;
              storyUpdates.peakPositionAt = currentTime;

              // Special case: if it just became #1 and we haven't sent a #1 notification
              if (isNumberOne && !existingStory.notifiedNumberOne && isFromVerifiedUser) {
                storyUpdates.notifiedNumberOne = true;
                storyUpdates.notifiedAt = existingStory.notifiedAt || currentTime;
                shouldSendNotification = true;
                notificationType = "number_one_story";
              }
            }

            if (story.score > (existingStory.peakScore || 0)) {
              storyUpdates.peakScore = story.score;
              storyUpdates.peakScoreAt = currentTime;
            }
          }
        } else if (!existingStory.isOnLeaderboard) {
          // Not on leaderboard but we should update the position anyway
          storyUpdates.position = position;
        }

        // Update the story in our database
        await db
          .update(storiesTable)
          .set(storyUpdates)
          .where(eq(storiesTable.id, story.id));

        // Send notification if needed
        if (shouldSendNotification) {
          await sendNotification(story, notificationType);
        }
      }
    }

    // Mark stories that have exited the leaderboard
    await db
      .update(storiesTable)
      .set({
        isOnLeaderboard: false,
        exitedLeaderboardAt: currentTime,
      })
      .where(
        and(
          eq(storiesTable.isOnLeaderboard, true),
          // Not in the current front page
          notInArray(storiesTable.id, frontPageIds),
        ),
      );
  } catch (error) {
    console.error("Error processing stories:", error);
    Sentry.captureException(error);
  }
}

/**
 * Check if a user is verified in our system
 */
async function isVerifiedUser(username: string): Promise<boolean> {
  if (!username) return false;

  const user = await db
    .select()
    .from(usersTable)
    .where(
      and(
        eq(usersTable.verified, true),
        eq(usersTable.hackernewsUsername, username.toLowerCase()),
      ),
    )
    .then((a) => a[0]);

  return !!user;
}

/**
 * Clean up expired stories
 */
/**
 * Record a snapshot of a story's position on the leaderboard
 * This data can be used to generate graphs showing position over time
 */
async function recordLeaderboardSnapshot({
  storyId,
  position,
  score,
  timestamp,
  isFromVerifiedUser,
  expiresAt,
}: {
  storyId: number;
  position: number;
  score: number;
  timestamp: number;
  isFromVerifiedUser: boolean;
  expiresAt: number | null;
}) {
  try {
    // Calculate TTL for the snapshot - either match story TTL or use default
    const snapshotExpiresAt =
      expiresAt ||
      Math.floor(addDays(new Date(), RETENTION_DAYS).getTime() / 1000);

    // Add the snapshot to the leaderboard_snapshots table
    await db.insert(leaderboardSnapshots).values({
      storyId,
      timestamp,
      position,
      score,
      expiresAt: snapshotExpiresAt,
    });
  } catch (error) {
    console.error("Error recording leaderboard snapshot:", error);
    Sentry.captureException(error);
  }
}

async function cleanupExpiredStories() {
  try {
    const currentTime = Math.floor(Date.now() / 1000);

    // Get count of stories to delete
    const expiredCount = await db
      .select({ count: count() })
      .from(storiesTable)
      .where(
        and(
          // Only delete stories with expiration set (not null)
          // and expired (expiration time less than current time)
          not(isNull(storiesTable.expiresAt)),
          lt(storiesTable.expiresAt, currentTime),
        ),
      )
      .then((a) => a[0]);

    if (expiredCount && Number(expiredCount.count) > 0) {
      console.log(`Cleaning up ${expiredCount.count} expired stories`);

      // Delete expired stories
      await db
        .delete(storiesTable)
        .where(
          and(
            not(isNull(storiesTable.expiresAt)),
            lt(storiesTable.expiresAt, currentTime),
          ),
        );
    }

    // Also clean up expired leaderboard snapshots
    const expiredSnapshotsCount = await db
      .select({ count: count() })
      .from(leaderboardSnapshots)
      .where(lt(leaderboardSnapshots.expiresAt, currentTime))
      .then((a) => a[0]);

    if (expiredSnapshotsCount && Number(expiredSnapshotsCount.count) > 0) {
      console.log(
        `Cleaning up ${expiredSnapshotsCount.count} expired leaderboard snapshots`,
      );

      await db
        .delete(leaderboardSnapshots)
        .where(lt(leaderboardSnapshots.expiresAt, currentTime));
    }
  } catch (error) {
    console.error("Error cleaning up expired data:", error);
    Sentry.captureException(error);
  }
}

/**
 * Send notification for a story
 */
async function sendNotification(
  story: Story,
  notificationType:
    | "new_story_by_verified_user"
    | "front_page_story"
    | "number_one_story",
) {
  try {
    console.log(
      `Sending ${notificationType} notification for story ${story.id} by ${story.by}`,
    );

    // Import the Slack app
    const { slackApp } = await import("../../index");

    // Get the Slack user ID for the HN username
    const user = await db
      .select()
      .from(usersTable)
      .where(eq(usersTable.hackernewsUsername, story.by))
      .then((a) => a[0]);

    const slackUserId = user?.id;
    const slackMention = slackUserId ? `<@${slackUserId}>` : "";

    // Create the notification message with story details
    let headerText = "";
    if (notificationType === "new_story_by_verified_user") {
      headerText = `*New story from verified user <https://news.ycombinator.com/user?id=${story.by}|${story.by}>* ${slackMention}`;
    } else if (notificationType === "number_one_story") {
      headerText = `*🏆 Story has reached #1 on Hacker News! By <https://news.ycombinator.com/user?id=${story.by}|${story.by}>* ${slackMention}`;
    } else {
      headerText = `*Story by <https://news.ycombinator.com/user?id=${story.by}|${story.by}> made it to the front page!* ${slackMention}`;
    }

    // Customize blocks based on notification type
    const blocks: AnyMessageBlock[] = [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: headerText,
        },
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*<${story.url || `https://news.ycombinator.com/item?id=${story.id}`}|${story.title}>*\n${story.text || ""}`,
        },
      },
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: `<https://news.ycombinator.com/item?id=${story.id}|View on Hacker News> • ${story.score || 0} points • ${story.descendants || 0} comments`,
          },
        ],
      },
    ];

    // Add extra emphasis for #1 ranked story
    if (notificationType === "number_one_story") {
      blocks.splice(1, 0, {
        type: "section",
        text: {
          type: "mrkdwn",
          text: "🔥 *This story has reached the #1 position on Hacker News!* 🔥",
        },
      });
    }

    // Send the message
    await slackApp.client.chat.postMessage({
      channel: process.env.SLACK_CHANNEL as string,
      text: headerText,
      blocks: blocks,
    });
  } catch (error) {
    console.error("Error sending notification:", error);
    Sentry.captureException(error);
  }
}

/**
 * The main function to check HackerNews and process updates
 */
async function checkHackerNews() {
  try {
    // Process stories - unified processing with one API call
    await processStories();

    // Clean up expired stories
    await cleanupExpiredStories();
  } catch (error) {
    console.error("Error in checkHackerNews:", error);
    Sentry.captureException(error);
  }
}

// Create the cron job with Sentry monitoring
const CronJobWithCheckIn = Sentry.cron.instrumentCron(
  CronJob,
  "hn-monitor-job",
);

/**
 * Set up HackerNews monitoring service
 */
export function setupHackerNewsMonitoring() {
  // Create and start the scheduled job
  if (environment === "production") {
    const job = CronJobWithCheckIn.from({
      cronTime: CHECK_INTERVAL, // Check every 5 minutes (configurable)
      onTick: checkHackerNews,
      start: true,
      timeZone: "UTC",
    });
  }

  // Run immediately on startup
  checkHackerNews();

  console.log("HackerNews monitoring service started");
}
