# Google Mail + Calendar Integration Setup

The CRM code is now prepared to use the same Google OAuth connection for both Gmail and Google Calendar.

## Required Google Cloud Setup

Use the same OAuth 2.0 Client ID in Google Cloud for a web application.

Enable these APIs in the same Google Cloud project:

- Gmail API
- Google Calendar API

You will need:

- `gmail_client_id`
- `gmail_client_secret`

## Redirect URI

Authorize this redirect URI in the Google OAuth client:

`https://YOUR-DOMAIN-HERE/server.php?action=gmail_oauth_callback`

If you are testing locally, use the exact local origin you load the CRM from.

Example:

- `http://localhost/measure/internal/server.php?action=gmail_oauth_callback`

## Google API Scopes Used

The CRM now requests these scopes in the same Google consent flow:

- `https://www.googleapis.com/auth/gmail.send`
- `https://www.googleapis.com/auth/gmail.readonly`
- `https://www.googleapis.com/auth/calendar.events`
- `https://www.googleapis.com/auth/calendar.readonly`
- `openid`
- `email`
- `profile`

## Server Config Keys

Store these in server config:

- `gmail_client_id`
- `gmail_client_secret`
- `gmail_redirect_uri` (optional override; if omitted, the CRM auto-builds it from the current host)

## What Happens After Config Is Added

1. SDR opens a lead and clicks either `Connect Gmail` or `Connect Google`.
2. The Google OAuth popup connects the SDR account for Gmail and Calendar.
3. Lead email sends through Gmail only.
4. Gmail thread history syncs back into the lead Activity feed.
5. Lead scheduling creates real Google Calendar events and can invite contacts / create Meet links.

## If Gmail Was Already Connected Before Calendar Was Added

Reconnect the Google account once so Google grants the new Calendar scopes too.

The CRM will show Gmail as connected but Calendar as disconnected until that reconnect happens.

## Current Remaining Product Work

These are still outside the credential-only setup step:

- Manager-managed Gmail template settings page
- Real attachment file payloads instead of attachment toggles only
- More Gmail-like compose UX polish such as multi-compose/minimize/drag/resize
- Rich Calendar availability views and deeper calendar sync beyond direct event creation
