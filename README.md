# Pocketwise Budget

A weekly budget tracker. Set a weekly amount, log what you spend, and see where your money goes.

## Two ways to run it

| | Hosted Claude page (recommended) | Local / GitHub Pages |
|---|---|---|
| Syncs across devices | Yes, privately to your Claude account | No, this browser only |
| Receipt scanning | Yes | No |
| Calendar export (.ics) | No | Yes |
| Works offline | Shows the last synced copy | Yes (installable app) |

**Privacy:** this repository holds only code, never anyone's data. On the hosted page, data is stored under your own private path (`data/users/<your id>/`) that nobody else can read, even if you share the page. If someone downloads this code, they get an empty app.

## Features
- **Weekly budget:** money left, safe-to-spend per day, safe-to-spend after this week's bills, optional rollover, budget history.
- **Categories:** custom icons and colors, weekly limits with warnings, and splitting one purchase across several categories.
- **Lifetime stats:** total spent, month vs last month, average per week, streaks, total unspent.
- **Calendar:** month grid with daily spending (color-coded against your daily budget), renewals, trial end dates, income, goal deadlines, and a 30-day agenda.
- **Subscriptions & bills:** monthly and yearly cost, share of your budget, free-trial tracking, and charges logged automatically on the due date.
- **Income:** one-off and recurring income, income vs spending chart, savings rate, and income that adds to that week's budget.
- **Wishlist & goals:** how much to save per week and per day, your pace and projected finish date.
- **Cooling-off list:** put an impulse buy on a 24h / 48h / 1 week / 30 day timer, then buy it or skip it. Shows the total saved by skipping.
- **Friends & IOUs:** split bills equally or with custom amounts (only your share counts as spending), lend and borrow, settle up.
- **Receipt scanning:** take a photo and Claude reads the total, store, date, line items and categories.
- **Reminders:** upcoming bills, free trials ending, low budget, category limits, goal deadlines, unpaid IOUs, an evening logging nudge.
- **Quick-add favorites:** log a regular purchase in one tap.
- **"Can I afford it?":** shows how a price affects this week, when you could afford it, and how much it delays your goals.
- **No-spend days & achievements:** 22 badges, a logging streak and an under-budget streak.
- **Reports:** monthly and yearly summaries with category changes and biggest purchases.
- **Insights:** category donut, weekly and monthly trends, weekday averages, heatmap, top places, tags, payment methods.
- **Quick add:** type “coffee 4.50” or “uber 12 yesterday #work” and press Enter. The category is picked from your history or common keywords.
- **Search & commands:** find any purchase, subscription, goal or friend, or run an action (press `/`).
- **Today card & month forecast:** today's share of the budget, plus a chart of where the month is heading.
- **Challenges:** ready-made and custom spending challenges with progress and wins.
- **Accounts & net worth:** type in your balances (no bank connection) and watch your net worth over time.
- **Round-up jar:** spare change from rounding purchases up, ready to move into a goal.
- **Recurring detection:** spots repeat purchases that look like subscriptions.
- **Weekly recap:** a summary of last week when a new week starts.
- **Guided setup, help page, hide-amounts privacy mode, bulk select, sorting, accent colors, compact layout, customizable dashboard.**
- **Tags, payment methods, refunds, duplicate, undo.**
- **PIN lock** (per device), light and dark themes, JSON backup and restore, CSV export.

## Development
Edit `index.html`, `styles.css` and `app.js`, then:
```
python3 -m http.server 8000            # run locally at http://localhost:8000
python3 tools/build-artifact.py        # bundle into dist/pocketwise.html for the hosted page
```
