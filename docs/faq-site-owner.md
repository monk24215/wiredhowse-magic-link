# Site Owner FAQ — wiredHowse Magic Link

## Getting Started

### What is wiredHowse Magic Link?

Magic Link is an email-based authentication service. Instead of passwords, your End Users receive a time-limited, single-use link in their email to sign in. This eliminates password reuse, weak passwords, and phishing vulnerabilities.

### How do I integrate it into my site?

Add one line of HTML to your page:

```html
<script
  src="https://magic-link.wiredhowse.app/v1/snippet.js"
  data-site-key="pk_your_site_key_here"
  data-mode="auto"
  async
  defer
></script>
```

The snippet handles everything: email entry, magic-link validation, session storage, and sign-out.

### What's the `data-site-key`?

A public identifier unique to your Site. You'll find it in your wiredHowse dashboard under **Settings → Site Keys**. It's safe to put in HTML.

### Do I need to modify my backend?

No. The snippet communicates with wiredHowse API directly. Your backend can trust the `Authorization: Bearer <token>` header when End Users make requests to you. Validate it by calling `/v1/me` on wiredHowse API with that token.

---

## Domain Verification

### Why do I need to verify my domain?

Verification confirms you own the domain. Once verified, your End Users' sessions are locked to your domain — a leaked token can't be used on another site.

### How do I verify my domain?

1. In the dashboard, go to **Settings → Domain**.
2. Add your domain (e.g., `customer-site.com`).
3. Choose verification method:
   - **DNS TXT record** (recommended): Add the TXT record wiredHowse shows. Verify with `dig` or your DNS provider's UI. Propagation usually <10 min.
   - **Meta tag**: Add the `<meta>` tag to your site's `<head>`. Verify by visiting the validation URL.
4. Click **Verify** when ready.

Your domain moves to `live` status. Sessions are now locked to it.

### What if I have multiple subdomains?

Each subdomain needs its own verification. `customer.com` and `api.customer.com` are different domains.

### Can I change my verified domain later?

Yes. Add the new domain, verify it, then delete the old one in **Settings → Domain**. Sessions on the old domain become invalid (users log in again). Plan accordingly.

---

## Snippet Integration

### What's `data-mode`?

- **`auto`** (default): Snippet checks for a valid session on page load. If none exists, it renders the email-entry iframe immediately. The page is gated behind the login.
- **`manual`**: Snippet loads but takes no action. You call `window.wiredhowseAuth.requireSession()` when you're ready to prompt login.

### How do I check if a user is logged in?

```javascript
const session = await window.wiredhowseAuth.getSession();
if (session) {
  console.log("Logged in as:", session.end_user.email);
} else {
  console.log("Not logged in");
}
```

### How do I show a sign-out button?

```html
<button onclick="window.wiredhowseAuth.signOut()">Sign Out</button>
```

### How do I access the user's email in my JavaScript?

```javascript
window.wiredhowseAuth.on('session', (session) => {
  console.log(session.end_user.email);
  console.log(session.end_user.display_name); // may be null
});
```

### Does the snippet need a CSP exemption?

If you have a strict Content Security Policy, allow:

```
script-src 'self' https://magic-link.wiredhowse.app;
frame-src https://magic-link.wiredhowse.app;
connect-src https://magic-link.wiredhowse.app;
```

### Can I customize the iframe appearance?

The email-entry iframe uses wiredHowse's default styling. Custom themes come in a future release. For now, you can:
- Pass a custom message: `window.wiredhowseAuth.requireSession({ message: "Please sign in to continue" })`
- Wrap the iframe in your own modal or container

### Is the snippet safe? Can it read my page?

Yes, it's safe. The iframe boundary isolates the authentication UI from your page's JavaScript. The snippet cannot:
- Read what the user typed
- Access `window` or `document` from your page
- Exfiltrate form data
- Run arbitrary scripts on your site

The source code is published at `https://magic-link.wiredhowse.app/v1/snippet.js` — you can inspect it.

---

## Sessions & Tokens

### How long do sessions last?

Sessions are **tied to login count**, not fixed:
- First login: **2 hours**
- Second to fourth login: **4 hours**
- Fifth to seventh login: **6 hours**
- Eighth login and beyond: **12 hours**

This tiering encourages cross-device auth while keeping fresh sessions secure.

### Can I extend a session?

Sessions don't auto-refresh. When the timer expires, the next `getSession()` returns `null` and the user logs in again. This is by design — it bounds the damage from a leaked token.

### What if a user closes their browser?

If they use a normal (non-private) browser, their session is stored in `localStorage` and persists across browser restarts. If they use private/incognito mode, the session is in `sessionStorage` and is cleared when they close the browser.

### Can multiple devices use the same account?

Yes. Each device gets its own session. A leaked session on one device doesn't affect the others. Users can view and revoke all their sessions in the **Sessions** tab of their account page.

### What if a user's session is compromised?

They can:
1. Click **Clear All Sessions** in their account page. All sessions worldwide are revoked.
2. Sign in again on their trusted device.
3. Old/compromised sessions become invalid.

Alternatively, they request a fresh magic link and sign in normally.

### How do I validate a session on my backend?

When an End User makes a request to your API with `Authorization: Bearer <token>`, call:

```bash
curl -H "Authorization: Bearer <token>" \
  https://magic-link.wiredhowse.app/v1/me
```

wiredHowse returns `{ data: { id, email, display_name } }` if valid, or `{ error }` if expired/invalid. Cache this for a few seconds to avoid hammering us.

---

## Email & Deliverability

### Why does my magic link go to spam?

Magic Link uses DMARC/SPF/DKIM to prevent spoofing. If your End Users see magic links in spam:

1. **Check their mail folder settings.** Sometimes users auto-forward everything from certain senders.
2. **Ensure domain verification passed.** Go to **Settings → Domain** and confirm the status is "live" (green).
3. **Wait for reputation.** New sending domains start with low reputation. After ~100 successful sends, Gmail and others improve inbox placement.
4. **Check authentication headers.** Forwarding services, mailing lists, and VPNs can break DMARC alignment. This is rare but contact support if it's widespread.

### Can I customize the magic-link email?

The email is sent by wiredHowse with a standard template. Custom branding comes in a future release. Currently it reads:

```
From: wiredHowse Auth <no-reply@magic-link.wiredhowse.app>

Hi,

Click the link below to sign in to [your domain]:

https://magic-link.wiredhowse.app/v1/magic/redeem?token=...

This link expires in 15 minutes and can only be used once.

If you didn't request this, you can ignore this email.

— wiredHowse
```

### How many magic links can my End Users send per day?

Each email can request **3 magic links every 15 minutes**. This prevents email bombing while allowing legitimate multi-device sign-ups.

---

## Troubleshooting

### The snippet won't load.

1. Check the `data-site-key`. It should start with `pk_`.
2. Open your browser's **Developer Tools → Network** tab. Look for requests to `magic-link.wiredhowse.app`. Are they failing?
   - **404**: Check the domain. Is it `magic-link.wiredhowse.app` (not `https://magic-link...`)?
   - **CORS error**: You likely don't have the domain whitelisted. Contact support with your domain name.
3. Clear your cache. The snippet is cached for 5 minutes.

### The iframe won't appear when I call `requireSession()`.

1. Check your browser console for errors (F12 → Console).
2. Ensure your CSP allows `frame-src https://magic-link.wiredhowse.app`.
3. Try from an incognito window to rule out extensions.
4. Check if your domain is verified (Settings → Domain, status should be "live").

### Users say they never received a magic link.

1. **Check spam folders.** Some providers still filter transactional mail.
2. **Verify domain status.** If not live, magic links don't send.
3. **Check rate limits.** If the same email requested >3 links in 15 minutes, older requests are silently dropped.
4. **Check email address.** Is it typo'd? The system doesn't validate email format on request (privacy), but invalid addresses fail silently.

### A user can't sign in to my site, but can elsewhere.

1. Ensure the user's **domain** is verified in your wiredHowse dashboard.
2. Have them clear `localStorage` and try again: `localStorage.clear()` in the browser console.
3. Try from a different browser or device.
4. Contact support with the user's email address (do not share tokens or sessions).

### How do I see my End Users' email addresses?

You don't. wiredHowse doesn't expose a user directory to Site Owners — only the logged-in user's own email via the `/me` endpoint. This is intentional (privacy).

If you need a list of who has signed up, request that your End Users can be queried by their own email only (future feature).

---

## Security & Best Practices

### Should I add extra authentication on top of this?

No. Magic Link is a complete authentication system. Adding passwords or another auth provider weakens your security posture and confuses users.

### What happens if my domain is hijacked?

If an attacker takes control of your DNS:
1. They can't immediately steal existing sessions (bound to domain, stored locally on users' devices).
2. They can create new fraudulent sessions by hosting a fake sign-in form.

Mitigation: use **DNSSEC** if your registrar supports it, enable **registrar lock**, and use **2FA on your registrar account**.

### Can I see my End Users' sessions?

From the **Dashboard → Sessions** tab, you can view a list of active sessions with approximate location and device type (no IP addresses). You can revoke any session from there.

### Should I run my own Magic Link service?

No. The overhead is significant: Resend integration, DMARC/SPF/DKIM setup, rate limiting, session management, threat modeling, backups. Let wiredHowse handle it.

### What happens if Magic Link goes down?

Your site can't issue new sessions, but existing sessions remain valid. Contact our status page at `status.wiredhowse.app` for updates. We maintain 99.9% uptime SLA on production.

### Is there a privacy policy I should link?

wiredHowse has a master privacy policy at `https://wiredhowse.app/privacy`. You might want to add: "Sign-in is powered by wiredHowse Magic Link. See their [privacy policy](https://wiredhowse.app/privacy)."

---

## Billing & Support

### What's the cost?

Free for MVP. As you scale, wiredHowse charges per End User per month. See the pricing page for details.

### Can I get support?

Email `support@wiredhowse.app` with questions, bugs, or feature requests. Response within 24 hours during US business hours.

### Is there an SLA?

Production targets 99.9% uptime. No SLA for free-tier accounts; paid tiers include SLA and priority support.

### Can I export my data?

Yes. From **Settings → Data Export**, download all your End User emails and session history as CSV. This supports GDPR/CCPA requests.
