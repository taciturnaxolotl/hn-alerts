# Hacker News Alerts

![screenshot of the web dashboard](.github/images/preview.webp)

<img src="https://cachet.dunkirk.sh/emojis/ycombinator/r" height="175" align="right" alt="ycombinator logo">

> ### Your personal Hacker News success tracker 📈 🔔 🚀  
> A slack bot that tracks when you make it to the front page of Hacker News; developed with 💖 @ [Hack Club](https://github.com/hackclub)  
>  
> ⚠️ **Highly optionated / mad teenager rants at computer warning** - From "I wish I had this" to "now we all do"

## 🔥 What it does

HN Alerts watches Hacker News for you and anyone else that chooses to trust your instructions to run `/hn-alerts-link`, notifying you through Slack when:

- Your posts appear on the front page (top 30)
- Your posts climb the rankings
- Your posts reach the coveted #1 position 🏆
- Any significant changes to your post's performance

The dashboard provides:
- Real-time position tracking with historical graphs
- Performance metrics (peak position, time on front page, comment activity)
- Leaderboard of all tracked stories
- Detailed analytics for each post's journey
- An excellent caching mechanism (this took me so very long to implement)

## 🚧 Dev

You can launch the bot locally with bun

```bash
bun install
bun dev
```

you will also need to launch an ngrok tunnel and update your dev slack manifest to point to the ngrok tunnel

```bash
bun ngrok
```

you also need to create a `.env` file with the following keys

```bash
SLACK_BOT_TOKEN="xoxb-xxxxx-xxxxx-xxxxx-xxxxx"
SLACK_SIGNING_SECRET="xxxxx"
SLACK_CHANNEL="C08KX2YNN87"
NODE_ENV="dev"
SENTRY_DSN="https://xxxxxx@xxxxxx.ingest.us.sentry.io/xxxx"
```

Don't forget to initialize your database:

```bash
bun db:push
```

## 📱 Slack Commands

- `/hn-alerts-link your_username` - Link your Hacker News account
- `/hn-alerts-link verify` - Verify your Hacker News account (post the challenge code to your HN profile)
- `/hn-alerts-link unlink` - Remove your linked account
- `/hn-alerts-link help` - Show command help

## 📜 License

The code is licensed under `MIT`! That means MIT allows for free use, modification, and distribution of the software, requiring only that the original copyright notice and disclaimer are included in copies.

<p align="center">
	<img src="https://raw.githubusercontent.com/taciturnaxolotl/carriage/master/.github/images/line-break.svg" />
</p>

<p align="center">
	<i><code>&copy 2025-present <a href="https://github.com/taciturnaxolotl">Kieran Klukas</a></code></i>
</p>

<p align="center">
	<a href="https://github.com/taciturnaxolotl/hn-alerts/blob/master/LICENSE.md"><img src="https://img.shields.io/static/v1.svg?style=for-the-badge&label=License&message=MIT&logoColor=d9e0ee&colorA=363a4f&colorB=b7bdf8"/></a>
</p>
