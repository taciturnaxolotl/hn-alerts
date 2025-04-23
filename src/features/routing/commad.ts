import { eq } from "drizzle-orm";
import { slackApp, db } from "../../index";
import { users as usersTable } from "../../libs/schema";
import {
  handleVerify,
  handleUnlink,
  handleHelp,
  handleLinkRequest,
} from "../handler/linking";

export async function commandSetup() {
  try {
    slackApp.command(
      "/hn-alerts-link",
      () => Promise.resolve(),
      async ({ payload, context }) => {
        const input = payload.text?.trim() || "";
        const userId = payload.user_id;
        const command = input.split(" ")[0]?.toLowerCase() ?? "";

        const userFromDB = await db
          .select()
          .from(usersTable)
          .where(eq(usersTable.id, userId))
          .then((user) => user[0]);

        let responseText = "";

        // Handle commands using a switch statement
        switch (command) {
          case "verify":
            if (!userFromDB) {
              responseText =
                "You don't have a pending verification. Use `/hn-alerts-link your_username` first.";
            } else if (userFromDB.verified) {
              responseText = "Your account is already verified.";
            } else {
              responseText = await handleVerify(
                userId,
                userFromDB.hackernewsUsername as string,
                userFromDB.challenge as string,
              );
            }
            break;

          case "unlink":
            if (!userFromDB) {
              responseText = "You don't have a linked Hacker News account.";
            } else {
              responseText = await handleUnlink(userId);
            }
            break;

          case "help":
            responseText = handleHelp();
            break;

          default:
            // If the user is already linked and verified
            if (userFromDB?.verified) {
              responseText = `You are already linked to the <https://news.ycombinator.com/user?id=${userFromDB.hackernewsUsername}|\`${userFromDB.hackernewsUsername}\`> Hacker News account. Use \`/hn-alerts-link unlink\` to remove the link.`;
            }
            // If there's a pending verification
            else if (userFromDB) {
              responseText = await handleVerify(
                userId,
                userFromDB.hackernewsUsername as string,
                userFromDB.challenge as string,
              );
            }
            // Handle new link request (when no command specified, treat input as username)
            else {
              responseText = await handleLinkRequest(userId, input);
            }
        }

        await context.respond({
          text: responseText,
          response_type: "ephemeral",
        });
      },
    );
  } catch (error) {
    console.error("Error setting up linking", error);
  }
}
