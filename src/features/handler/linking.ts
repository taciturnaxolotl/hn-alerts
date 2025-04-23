import { eq } from "drizzle-orm";
import { db, slackApp } from "../../index";
import { users as usersTable } from "../../libs/schema";
import { generatePassphrase } from "../../libs/words";
import { getUser } from "../../libs/hackernews";

// Helper functions for each command action
async function handleLinkRequest(
  userId: string,
  userInput: string | null,
): Promise<string> {
  let hnUsername = userInput;

  // Extract username from URL if provided
  if (userInput?.includes("news.ycombinator.com/user?id=")) {
    try {
      const cleanedInput = userInput.replace(/[<>]/g, "");
      const username = new URL(cleanedInput).searchParams.get("id");
      if (username) hnUsername = username;
    } catch (e) {
      console.log("Failed to parse URL, using raw input", e);
    }
  }

  if (!hnUsername) {
    return "Please provide your Hacker News username: `/hn-alerts-link your_username`";
  }

  const verificationPhrase = generatePassphrase(3);

  await db.insert(usersTable).values({
    id: userId,
    hackernewsUsername: hnUsername,
    challenge: verificationPhrase,
  });

  return `Please verify your Hacker News username: <https://news.ycombinator.com/user?id=${hnUsername}|\`${hnUsername}\`> by adding the verification phrase: \`${verificationPhrase}\`. When you're done, type \`/hn-alerts-link verify\` to complete the process.`;
}

async function handleVerify(
  userId: string,
  hackernewsUsername: string,
  challenge: string,
): Promise<string> {
  const res = await getUser(hackernewsUsername as string).then((user) =>
    user?.about?.includes(challenge as string),
  );

  if (!res) {
    return `Your Hacker News account is not verified. Add \`${challenge}\` to your <https://news.ycombinator.com/user?id=${hackernewsUsername}|profile>.`;
  }

  await db
    .update(usersTable)
    .set({ verified: true })
    .where(eq(usersTable.id, userId));

  return "Your Hacker News account has been verified :yay:";
}

async function handleUnlink(userId: string): Promise<string> {
  await db.delete(usersTable).where(eq(usersTable.id, userId));

  return "Your Hacker News account has been unlinked successfully.";
}

function handleHelp(): string {
  return (
    "Available commands:\n" +
    "• `/hn-alerts-link your_username` - Link your account\n" +
    "• `/hn-alerts-link verify` - Verify your Hacker News account\n" +
    "• `/hn-alerts-link unlink` - Remove your linked account\n" +
    "• `/hn-alerts-link help` - Show this help message"
  );
}

export { handleVerify, handleUnlink, handleHelp, handleLinkRequest };
