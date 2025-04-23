# Hacker News Alerts

<img src="https://cachet.dunkirk.sh/emojis/ycombinator/r" height="175" align="right" alt="ycombinator logo">

> ### More deets coming soon 👀
>
> A slack bot that tracks whether you made it to the front page of hn; made with 💖 @ [Hack Club](https://github.com/hackclub)
>
> ⚠️ **Highly opinionated slack bot warning** - Project rapidly iterating

# 🚧 Dev

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

## 📜 License

The code is licensed under `AGPL 3.0`! That means AGPL 3.0 requires publishing source code changes when the software is used over a network, guaranteeing that users can access the code. All artwork and images are copyright reserved but may be used with proper attribution to the authors.

<p align="center">
	<img src="https://raw.githubusercontent.com/taciturnaxolotl/carriage/master/.github/images/line-break.svg" />
</p>

<p align="center">
	<i><code>&copy 2025-present <a href="https://github.com/taciturnaxolotl">Kieran Klukas</a></code></i>
</p>

<p align="center">
	<a href="https://github.com/taciturnaxolotl/hn-alerts/blob/master/LICENSE.md"><img src="https://img.shields.io/static/v1.svg?style=for-the-badge&label=License&message=MIT&logoColor=d9e0ee&colorA=363a4f&colorB=b7bdf8"/></a>
</p>
