# Home access

Live and same-day usage is shown only to enrolled devices, which carry a signed
cookie valid for 30 days after last use. Everyone else sees usage to the end of
yesterday.

Worker secrets:

```bash
bunx wrangler secret put HOME_ASSISTANT_TOKEN       # Home Assistant's bearer token
bunx wrangler secret put HOME_COOKIE_SECRET         # signs cookies; rotate to revoke them
bunx wrangler secret put HOME_ASSISTANT_WEBHOOK_URL # https://<HA external host>/api/webhook/<id>
```

A device enrols from anywhere by asking for a code and four check digits. The
Worker POSTs both to the webhook as `?code=` and `?check=`, so the webhook must
be reachable from the internet: set `local_only: false` on its trigger. The
browser never sees the webhook's address. If the webhook does not answer with a
2xx within five seconds, the page says it couldn't reach Home Assistant and no
code is handed out. Once a household phone approves the digits shown on
ldn.house, Home Assistant confirms both:

```http
POST /api/home/confirm
Authorization: Bearer <HOME_ASSISTANT_TOKEN>
Content-Type: application/json

{"code": "<the webhook's ?code=>", "check": "<the webhook's ?check=>"}
```

Home Assistant can also mint a one-time link, `{"url": …, "expiresAt": …}`,
to send to the device:

```http
POST /api/home/codes
Authorization: Bearer <HOME_ASSISTANT_TOKEN>
```

Home Assistant should call `https://ldn.house` directly rather than `www`: the
301 redirect can turn a POST into a GET.

Codes are single-use and expire after ten minutes. Locally and on PR previews,
`?as=home` and `?as=outsider` set and clear the cookie.
