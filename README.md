# strava-sync

A GitHub Action that pulls your runs from Strava at **1pm and 8pm Dublin time** and saves them to `data/runs.json`. The RunAudio app downloads that file for its **Runs** page. No server needed, and it works wherever the app is hosted (Netlify, GitHub Pages, anywhere), because GitHub's raw file host allows requests from any site.

What is saved per run: date, distance, moving time, elapsed time, elevation, average and max heart rate. **Not saved:** GPS routes, coordinates, gear, photos. Run names are left out too (they often mention places) unless you turn them on in step 6.

> The repo must be **public** so the app can read the file without logging in. That is why only summary numbers are kept.

## One-time setup (about 10 minutes)

### 1. Make the GitHub repo
Create a new **public** repo (e.g. `strava-sync`) and upload everything in this folder, including the `.github` folder. On the repo page choose *Add file → Upload files* and drag the contents in, or use git.

### 2. Create a Strava API app
Go to https://www.strava.com/settings/api and create an app. Any name and website. Set **Authorization Callback Domain** to `localhost`. Note the **Client ID** and **Client Secret**.

### 3. Authorise it once
Open this in your browser (put your Client ID in):

```
https://www.strava.com/oauth/authorize?client_id=YOUR_CLIENT_ID&response_type=code&redirect_uri=http://localhost&approval_prompt=force&scope=activity:read_all
```

Tap **Authorize**. The next page won't load (that's fine). Copy the `code=` value from the address bar. Use `activity:read` instead of `activity:read_all` if you'd rather not include runs you've set to private.

### 4. Swap the code for a refresh token
Run this on a computer (the code expires in a few minutes):

```bash
curl -X POST https://www.strava.com/oauth/token \
  -d client_id=YOUR_CLIENT_ID -d client_secret=YOUR_CLIENT_SECRET \
  -d code=THE_CODE -d grant_type=authorization_code
```

Copy the `refresh_token` value from the reply.

### 5. Add the GitHub secrets
Repo → *Settings → Secrets and variables → Actions → New repository secret*:

| Secret | Value |
|---|---|
| `STRAVA_CLIENT_ID` | from step 2 |
| `STRAVA_CLIENT_SECRET` | from step 2 |
| `STRAVA_REFRESH_TOKEN` | from step 4 |
| `GH_PAT` | a fine-grained personal access token, see below |

**Why `GH_PAT`:** Strava can replace your refresh token with a new one, and the old one then stops working. The Action saves the new one back into the secret, and GitHub only lets a personal token do that. Create it at https://github.com/settings/personal-access-tokens/new : *Only select repositories* → this repo, and under *Repository permissions* set **Secrets** to *Read and write*. If you skip this, syncing works until the first rotation and then fails.

### 6. Run it
Repo → *Actions → Sync Strava runs → Run workflow*. The first run downloads your **entire existing run history** from Strava, so `data/runs.json` is filled in after a minute or two (longer if you have thousands of runs). Later runs only fetch what is new. To rebuild everything from scratch, tick **full** when you press *Run workflow*. From then on it runs by itself at 1pm and 8pm Dublin time.

Optional: to include run names, add a repo **variable** (not a secret) `INCLUDE_NAMES` = `true` under *Settings → Secrets and variables → Actions → Variables*.

### 7. Point the app at it
In RunAudio open the menu → **Runs → Data source** and paste:

```
https://raw.githubusercontent.com/YOUR_USERNAME/strava-sync/main/data/runs.json
```

Tap **Save & load**. The app re-checks whenever you open Runs (at most every 10 minutes) and keeps the last copy for offline use.

## Good to know
- GitHub starts scheduled runs 10 to 30 minutes late at busy times, and the raw file can lag about 5 minutes behind a commit.
- GitHub pauses scheduled workflows in a repo with no activity for 60 days. Commits of new runs count as activity; if you stop running for two months, press *Run workflow* once to wake it.
- The Action only commits when something changed, so quiet days leave no trace.
- Handles `Run`, `TrailRun` and `VirtualRun` activities; rides, walks etc. are ignored.
