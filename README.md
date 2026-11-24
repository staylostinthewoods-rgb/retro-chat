# Eyeliner & Mortgages: retro chatroom

A late-90s/early-2000s "Java chat applet" look, built with plain HTML/CSS/JS and a
small Node server. No dependencies, no build step. Needs Node 18+.

Files: `server.js`, `index.html`, `style.css`, `chat.js` (keep them in one folder).

## Run it on your computer

    node server.js
    # open http://localhost:3000 in two browser tabs and chat to yourself

Optional settings (environment variables):

    PORT=3000
    ADMIN_KEY=pick-a-long-secret        # enables moderator login
    ALLOWED_ORIGINS=https://yoursite.com,https://www.yoursite.com

## Commands

    /help  /me <action>  /msg <nick> <text>  /join #room  /rooms  /who
    /nick <name>  /clear  /op <key>
    Moderators (after /op <key>): /kick <nick>  /mute <nick>  /unmute <nick>

Double-click a username to start a private message. Click a room to join it.
Up/Down arrows recall what you typed. Your nickname being mentioned beeps.

## Putting it on your website

The chat needs a long-running server, so ordinary shared hosting (WordPress-style,
PHP-only) will not work. You need somewhere that can run a Node process and
supports WebSockets, for example Render, Fly.io, Railway, or a small VPS.

1. Deploy these four files and run `node server.js` (set `ADMIN_KEY` and
   `ALLOWED_ORIGINS` as environment variables on the host).
2. Give it its own address, e.g. `https://chat.yoursite.com`. The host must serve it
   over HTTPS (Render and Fly do this automatically). The page then uses secure
   WebSockets (wss://) on its own.
3. Embed it in any page on your main site:

       <iframe src="https://chat.yoursite.com/" title="Chat"
               style="width:100%;max-width:800px;height:520px;border:0"></iframe>

4. Set `ALLOWED_ORIGINS=https://yoursite.com` so other sites cannot embed it or
   connect to it.

If you use your own VPS with nginx in front, WebSocket traffic needs these lines in
the location block that proxies to Node:

    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_read_timeout 3600s;

## Limits of this prototype

- Everything lives in memory: restarting the server clears rooms and history.
- One server process only (no scaling across several servers).
- Nicknames are not accounts; anyone can pick any free name.
- No logging of messages, no persistent bans, no report button yet.
- The "I am 18 or over" box is self-declaration only. It is not age verification.

## Before going public (UK)

Chat rooms that let users talk to each other count as "user-to-user services" under
the Online Safety Act. Even for a friendly 18+ community you will be expected to run
an illegal-content risk assessment, have terms of service, a way to report content,
and a complaints process. If any sexual content is allowed, much stricter age
checks apply. Read Ofcom's guidance for smaller services and consider a short
chat with a solicitor. Practical next steps for this code: persistent bans,
a report button, message logging for moderators, and a proper privacy notice.
