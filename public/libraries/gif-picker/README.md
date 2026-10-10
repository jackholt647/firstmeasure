# Shared GIPHY browser runtime

The shared [Platform Widgets picker](../platform-widgets/README.md), consumed
by Channels and the widget catalog, uses the official `@giphy/js-components` grid and
`@giphy/js-fetch-api`, bundled locally as an ES module. Versions and dependencies
are locked in this directory. Rebuild with `npm ci` and `npm run build` here.
The main platform runtime does not install these packages at startup.

Upstream: https://github.com/Giphy/giphy-js. Open-source dependency notices are
in `THIRD_PARTY_LICENSES.txt`; GIPHY service use also requires its SDK agreement.
The SDK performs its standard analytics/pingbacks and fetches results directly
from GIPHY. The shared widget and composer button open a compact, non-modal
popover beside the trigger, with search, a two-column grid and GIPHY attribution.
Selecting a GIF sends or confirms it directly, like the emoji picker. Escape,
clicking outside or pressing the trigger again dismisses it. PG filtering remains.
GIFs remain hosted by GIPHY; we store the selected URL and descriptive metadata,
not a rehosted copy. Deleted messages hide that metadata like other content.

Set `GIPHY_WEB_SDK_KEY` in the environment's external service configuration. The
authenticated Channels `/organizations/:orgId/gifs/config` route provides the
web SDK application key to the browser as required by the SDK. Do not put the
key in Git, release archives, documentation or logs. This is a browser app key,
not the GIPHY account password. Absent configuration and provider quota/network
errors display an inline explanation without blocking messaging.

The FirstMate Channels Web application was registered September 29, 2026. Its
initial beta allowance is 100 API calls/hour; a production key requires GIPHY
review. Dev authorization does not authorize a paid production upgrade.
