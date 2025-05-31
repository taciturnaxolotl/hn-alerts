# Hacker News Alerts

![screenshot of the web dashboard](.github/images/preview.webp)

<img src="https://cachet.dunkirk.sh/emojis/ycombinator/r" height="175" align="right" alt="ycombinator logo">

A Slack bot that tracks when you make it to the front page of Hacker News, made with 💖 @ [Hack Club](https://github.com/hackclub)

## 🚀 Features

- **Front Page Tracking**: Get notified when your posts reach the Hacker News front page
- **#1 Post Alerts**: Special notifications when your post reaches the coveted #1 position
- **Leaderboard History**: Track how your posts perform over time with rank and point history
- **Web Dashboard**: View all currently tracked stories and their stats
- **Individual Story Pages**: View detailed information about any story using HN-compatible URLs
- **User Verification**: Securely link your HN account with Slack using verification phrases

## 🚧 Development Setup

### Prerequisites

- [Bun](https://bun.sh/) (JavaScript runtime and package manager)
- PostgreSQL database
- Ngrok for local development with Slack

### Local Development

1. Clone the repository:

```bash
git clone https://github.com/taciturnaxolotl/hn-alerts.git
cd hn-alerts
```

2. Install dependencies:

```bash
bun install
```

3. Create a `.env` file with the following variables:

```bash
SLACK_BOT_TOKEN="xoxb-xxxxx-xxxxx-xxxxx-xxxxx"
SLACK_SIGNING_SECRET="xxxxx"
SLACK_CHANNEL="C08KX2YNN87"
NODE_ENV="dev"
SENTRY_DSN="https://xxxxxx@xxxxxx.ingest.us.sentry.io/xxxx"
DATABASE_URL="postgres://user:password@host:5432/table_name"
```

4. Initialize the database schema:

```bash
bun db:push
```

5. Start the development server:

```bash
bun dev
```

6. In a separate terminal, launch ngrok to expose your local server:

```bash
bun ngrok
```

7. Update your Slack app's manifest in `manifest.dev.yaml` to point to your ngrok URL

## 📱 Slack Commands

- `/hn-alerts-link your_username` - Link your Hacker News account
- `/hn-alerts-link verify` - Verify your Hacker News account
- `/hn-alerts-link unlink` - Remove your linked account
- `/hn-alerts-link help` - Show command help

## 🧰 Tech Stack

- [Bun](https://bun.sh/) - JavaScript runtime and package manager
- [Slack Edge](https://github.com/slack-edge/slack-edge) - Slack API client
- [Drizzle ORM](https://orm.drizzle.team/) - Database ORM
- [Sentry](https://sentry.io/) - Error tracking
- [Cron](https://github.com/kelektiv/node-cron) - Scheduled tasks

## 📜 License

The code is licensed under `MIT`! See the [LICENSE.md](LICENSE.md) file for more details.

<p align="center">
	<img src="https://raw.githubusercontent.com/taciturnaxolotl/carriage/master/.github/images/line-break.svg" />
</p>

<p align="center">
	<i><code>&copy 2025-present <a href="https://github.com/taciturnaxolotl">Kieran Klukas</a></code></i>
</p>

<p align="center">
	<a href="https://github.com/taciturnaxolotl/hn-alerts/blob/master/LICENSE.md"><img src="https://img.shields.io/static/v1.svg?style=for-the-badge&label=License&message=MIT&logoColor=d9e0ee&colorA=363a4f&colorB=b7bdf8"/></a>
</p>
