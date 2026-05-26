# End User FAQ — wiredHowse Magic Link

## How Magic Link Works

### What is a magic link?

A magic link is a single-use, time-limited email link that lets you sign in without a password. Instead of remembering a password, you receive a link in your email. Click it, and you're signed in.

### Why use a magic link instead of a password?

Magic links are safer:
- No weak passwords to guess.
- No password reuse across sites (where one breach compromises many accounts).
- No phishing passwords — attackers can't intercept what doesn't exist.
- Inherently supports multi-device sign-in (each device gets its own link).

### How do I sign in with a magic link?

1. Go to the site and enter your email.
2. Check your email (usually arrives in 15 seconds).
3. Click the link in the magic-link email. It expires in 15 minutes and can only be used once.
4. You're signed in. Your session lasts 2–12 hours depending on how often you use the service.

### Can I reuse the same link multiple times?

No. Each link is single-use. Once you click it, it's consumed. To sign in again later, request a new link.

### What if I don't receive the email?

1. Check your spam folder (some email providers filter transactional mail).
2. Verify your email address is correct (typos silently fail).
3. Wait a few seconds — delivery is usually instant but not guaranteed.
4. Try again. You can request up to 3 new links every 15 minutes.

### What if my email is on a mailing list or forwarded?

If your email automatically forwards to another address, the magic link goes to the *original* email address (the one you entered), not the forwarded address. Sign in using the original email.

---

## Sessions & Devices

### How long does a session last?

Sessions are tied to **how often you use the service**, not a fixed timer:

- First time signing in: **2 hours**
- Second to fourth sign-in: **4 hours**
- Fifth to seventh sign-in: **6 hours**
- Eighth sign-in and beyond: **12 hours**

This tiering encourages you to use multiple devices (getting longer sessions) while keeping fresh sessions secure.

### What happens when my session expires?

The site will ask you to sign in again. Request a fresh magic link and click it.

### Can I stay signed in forever?

No. Sessions expire based on login count. This is by design — if your session is leaked, expiration limits the damage.

### Can I be signed in on multiple devices?

Yes. Each device has its own separate session. If you sign in on your phone and your laptop, each gets its own session. If one session is compromised, the others are unaffected.

### What if I use private/incognito mode?

Your session is stored in temporary browser storage and cleared when you close the browser. You'll need to sign in again next time.

### How do I sign out?

Click the "Sign Out" button on the site. Your session is immediately revoked and you're logged out everywhere.

---

## Security & Privacy

### What if someone else gets a magic link sent to my email?

If someone requests a magic link using your email:
1. You'll receive the email.
2. **Don't click the link** if you didn't request it.
3. You can safely ignore it — it expires in 15 minutes anyway.
4. If this happens repeatedly, that's a sign someone knows your email and is trying to break in. Change your password elsewhere (if the site uses passwords), alert the site owner, and consider using a distinct email address for that site.

### What if a magic link email is intercepted?

Magic links are sent over HTTPS (encrypted). If your email is compromised after you sign in, an attacker could steal your session token. See the next section.

### What if someone steals my session token?

If an attacker steals your session token (e.g., via malware):
1. Go to your account page and click **Clear All Sessions**. All your sessions worldwide are revoked immediately.
2. Sign in again on a trusted device.
3. The attacker's stolen session becomes useless.

### Does the site get my email address?

Yes. The site owner can see your email (that's how magic link works). They cannot see it in a directory though — only you can view your own email via your account page. The site owner cannot see other users' emails.

The site operator does not:
- Store your password (there is no password).
- See your private conversations.
- Access other accounts on the service.

### Is my email sold or shared?

No. The site owner's privacy policy covers email handling. Read it if you're unsure. For wiredHowse Magic Link itself, see https://wiredhowse.app/privacy.

### How do I delete my account?

That depends on the individual site. Look for an account deletion option in your account settings. Some sites immediately delete all your data; others let you schedule deletion. Check the site's privacy policy for details.

---

## Troubleshooting

### The magic-link email went to spam.

This can happen with new services. Try:
1. **Check your spam folder** — it may be there.
2. **Add the sender to your contacts** — tell your email provider this is trusted mail.
3. **Try again** — the more you sign in, the better email reputation the service builds.

If it keeps going to spam after a few attempts, contact the site owner or support.

### I clicked the link but nothing happened.

The link may have expired (15-minute limit) or been used already. Request a fresh magic link and try again.

### The link says "Invalid" or "Expired."

This means:
- The link is older than 15 minutes, or
- The link was already used, or
- The link is malformed.

Request a fresh magic link.

### I'm on my phone and clicking the link just opens an empty page.

Some email apps open links in a built-in browser that doesn't share session storage with your regular browser. Try:
1. **Copy the link** and paste it into your main browser (Chrome, Safari, etc.).
2. Or **open the email in your regular email app** (Gmail, Outlook, etc.) instead of the in-app email reader.

### The site won't load after I sign in.

This usually means a temporary connection issue. Try:
1. Refresh the page.
2. Clear your browser cache and try again.
3. Try from a different browser or device.
4. Contact the site owner if the problem persists.

### I can sign in elsewhere but not to this site.

The site owner may have disabled your account, or your session may be restricted to one device. Try:
1. Clear your browser cache: press `Ctrl+Shift+Delete` (Windows) or `Cmd+Shift+Delete` (Mac), then select "Cookies and cached images."
2. Try from a different browser or device.
3. Request a fresh magic link.

If none of that works, contact the site owner — they can check your account status.

### How do I revoke a single session (e.g., lost phone)?

Go to your account page. You'll see a list of all your active sessions with device type and approximate location. Click **Revoke** next to the session you want to end. That session is immediately invalid.

### I lost my phone. What do I do?

1. Sign in on another device.
2. Go to your account page and click **Clear All Sessions**.
3. All sessions worldwide are revoked immediately — your phone's session is now invalid.
4. Sign in again on your remaining devices.

---

## Privacy & Data

### Does the site see my IP address?

Not directly — the site owner cannot see your exact IP. For privacy, IP addresses are hashed in logs. But the site does know your approximate geographic location (country/region, not city) for security purposes.

### What data do you keep about me?

The site owner keeps:
- Your email address.
- When you last signed in.
- Approximate location (city-level).
- Device type (phone, laptop, etc.).
- A hashed version of your IP for security.

They don't keep your password (there isn't one), your browsing history, or messages outside the service itself.

### Can I export my data?

That depends on the site. Look for a "Download My Data" option in your account settings. Sites using wiredHowse support GDPR and CCPA data exports.

### Can I delete my data?

Yes, via account deletion (see "How do I delete my account?" above). Once deleted, your email, sessions, and history are purged.

---

## Best Practices

### Keep your email secure.

Your email is the key to your account. Use a strong, unique password on your email provider. Enable two-factor authentication if possible. If your email is compromised, an attacker can request magic links to any site where you have an account.

### Don't click links from unexpected emails.

If you get a magic-link email you didn't request, ignore it. It expires in 15 minutes anyway.

### Use a unique email per site (optional).

If a site is breached, attackers learn your email but not your password (there isn't one). Using distinct emails per site means a breach of Site A doesn't directly expose you to attacks on Site B.

### Clear sessions if you lose a device.

If your phone is stolen or lost, sign in elsewhere and revoke all sessions immediately (see "I lost my phone" above).

### Report suspicious activity.

If you see sessions you don't recognize, click **Revoke** and contact the site owner.

---

## Contact & Support

If you have questions or issues:

1. **Check the site owner's help page** — they may have troubleshooting specific to their service.
2. **Contact the site owner** — use the "Contact Us" link on their site.
3. **For wiredHowse Magic Link issues**, email support@wiredhowse.app.

---

## General Questions

### Is magic link safe?

Yes. Magic links are safer than passwords because:
- No password to guess or reuse.
- Links are single-use and expire quickly.
- HTTPS encryption protects the link in transit.
- Your session can be revoked anytime.

### Can I use magic link on public computers?

Not recommended. Use your own device if possible. If you must use a public computer:
1. Sign out when you're done (don't rely on session expiration).
2. Don't check "Stay signed in" (this uses session storage).
3. Consider using private/incognito mode so the session is cleared when you close the browser.

### What if I forget my email?

You'll need to remember or retrieve it. Check:
- Your email provider's password recovery.
- Other sites where you used the same email (to confirm the address).
- A previous receipt or confirmation email.

Once you remember it, you can sign in with a fresh magic link.

### Can I have multiple accounts on the same site?

That depends on the site owner's policy. Some allow it, some don't. Check their terms or contact support.

### Do magic links work on all devices?

Yes. Desktop, phone, tablet — any browser. If you have trouble, see "Troubleshooting" above.
