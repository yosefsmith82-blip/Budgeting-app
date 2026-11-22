# Pocketwise Budget

A weekly budget tracker that runs in the browser and can be installed to your phone's home screen.

## Features
- **Weekly budget**: set an amount, log what you spend, and see what's left plus a safe-to-spend-per-day number. The week resets on the day you choose.
- **Optional rollover**: unspent money (or overspending) carries into next week.
- **Categories**: custom names, icons and colours, plus optional weekly limits with warnings.
- **Lifetime stats**: total spent, this month vs last month, average per week, under-budget streak, total unspent.
- **Subscriptions**: weekly, biweekly, monthly, quarterly or yearly billing, with monthly and yearly cost, share of your budget, upcoming bills, and charges logged automatically on the due date.
- **Wishlist & goals**: how much to save per week or day to hit a target date, your current pace and projected finish date, and money set aside from this week's budget.
- **Insights**: category donut, 12-week and 6-month trends, average by weekday, daily heatmap, top places, and written tips.
- **Activity**: search, filter by category and period, edit or delete with undo, refunds.
- **Data**: JSON backup and restore, CSV export, sample data, light and dark themes, works offline.

## Run it
Open `index.html`, or serve the folder:
```
python3 -m http.server 8000   # then visit http://localhost:8000
```
To use it on your phone, enable GitHub Pages for this repo (Settings → Pages → deploy from branch), open the URL in Safari or Chrome, and choose **Add to Home Screen**.

Your data is stored in that browser's local storage on that device only, so use **Settings → Export backup** regularly.
