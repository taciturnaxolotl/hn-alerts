import { slackApp } from "../../index";

export async function linkUserSetup() {
  try {
    slackApp.command(
      "/hn-alerts-link",
      () => Promise.resolve(),
      async ({ payload, context }) => {
        await context.respond({
          text: "Linking successful!",
          response_type: "ephemeral",
        });
      },
    );
  } catch (error) {
    console.error("Error setting up linking", error);
  }
}
