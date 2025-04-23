import { eq } from "drizzle-orm";
import { db, slackApp } from "../../index";
import { users as usersTable } from "../../libs/schema";
import { generatePassphrase } from "../../libs/words";
import { getUser } from "../../libs/hackernews";

export async function linkUserSetup() {
  try {
    slackApp.command(
      "/hn-alerts-link",
      () => Promise.resolve(),
      async ({ payload, context }) => {
        const userInput = payload.text?.trim() || null;
        let hnUsername = userInput;

        const userFromDB = await db
          .select()
          .from(usersTable)
          .where(eq(usersTable.id, payload.user_id))
          .then((user) => user[0]);

        if (userFromDB) {
          if (!userFromDB.verified) {
            const res = await getUser(
              userFromDB.hackernewsUsername as string,
            ).then((user) =>
              user?.about?.includes(userFromDB.challenge as string),
            );

            if (!res) {
              await context.respond({
                text: `Your Hacker News account is not verified. Add \`${userFromDB.challenge}\` to your <https://news.ycombinator.com/user?id=${userFromDB.hackernewsUsername}|profile>.`,
                response_type: "ephemeral",
              });
              return;
            }

            await db.update(usersTable).set({ verified: true });

            await context.respond({
              text: "Your Hacker News account has been verified :yay:",
              response_type: "ephemeral",
            });
            return;
          }

          await context.respond({
            text: "You are already linked to a Hacker News account.",
            response_type: "ephemeral",
          });
          return;
        }

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

        const verificationPhrase = generatePassphrase(3);

        await db.insert(usersTable).values({
          id: payload.user_id,
          hackernewsUsername: hnUsername,
          challenge: verificationPhrase,
        });

        await context.respond({
          text: hnUsername
            ? `Please verify your Hacker News username: <https://news.ycombinator.com/user?id=${hnUsername}|\`${hnUsername}\`> by adding the verification phrase: \`${verificationPhrase}\`. When you're done, type \`/hn-alerts-link\` to complete the process.`
            : "Please provide your Hacker News username: `/hn-alerts-link your_username`",
          response_type: "ephemeral",
        });
      },
    );
  } catch (error) {
    console.error("Error setting up linking", error);
  }
}
