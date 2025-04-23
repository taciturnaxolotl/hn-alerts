cd ~/hn-alerts
git restore bun.lock
git fetch --all
git reset --hard origin/main
bun install
bun db:push
systemctl --user restart smokie
