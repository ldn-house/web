# Home access

Live and same-day usage is shown only to enrolled devices, which carry a signed
cookie valid for 30 days after last use. Everyone else sees usage to the end of
yesterday.

Worker secrets:

```bash
bunx wrangler secret put HOME_ASSISTANT_TOKEN       # Home Assistant's bearer token
bunx wrangler secret put HOME_COOKIE_SECRET         # signs cookies; rotate to revoke them
bunx wrangler secret put HOME_ASSISTANT_WEBHOOK_URL # http://<HA LAN address>:8123/api/webhook/<id>
```

A device enrols from home by asking for a code and four check digits, which
the page sends to the local-only Home Assistant webhook. Once a household phone
approves the digits shown on ldn.house, Home Assistant confirms both:

```http
POST /api/home/confirm
Authorization: Bearer <HOME_ASSISTANT_TOKEN>
Content-Type: application/json

{"code": "<the webhook's ?code=>", "check": "<the webhook's ?check=>"}
```

Away from home, Home Assistant mints a one-time link, `{"url": …, "expiresAt": …}`,
to send to the device:

```http
POST /api/home/codes
Authorization: Bearer <HOME_ASSISTANT_TOKEN>
```

Home Assistant should call `https://ldn.house` directly rather than `www`: the
301 redirect can turn a POST into a GET.

Codes are single-use and expire after ten minutes. Locally and on PR previews,
`?as=home` and `?as=outsider` set and clear the cookie.
