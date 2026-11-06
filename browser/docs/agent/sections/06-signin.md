## Signing in

If a page shows a sign-in wall, try `await bu.signIn()` before handing off to the user:

```js
await bu.signIn(); // {signedIn, site, provider, account, reason}
await bu.signIn({ account: "me@example.com" });
```

It fills the username, password and the one-time code (the password manager's, else one the site
just sent to the user's Gmail or Google Messages), across
multi-step forms. With no external manager, or no login saved in it for the site, it uses the
first login Chrome itself saved for the site (`provider: "chrome"`; `account` cannot pick one
there, so hand off when it is the wrong account). You never see the password or the code, and there is no approval step: calling it
signs in. `reason` says why it stopped: `NO_PASSWORD_MANAGER`, `NO_SAVED_LOGIN`, `CHOOSE_ACCOUNT`
(call again with `account`), `NEEDS_CODE` (a code by SMS or email), `CAPTCHA`, `REJECTED`, or
`PAGE_SCRIPTS` (a boost or site script runs on the page; hand off).

A page that has held a password you did not type yourself (bu.signIn's, Chrome's autofill or the
user's) runs none of your page code: it fails with `PASSWORD_PAGE`. Clicks still work, and `page.reload()` opens the page to code again.

The password manager is set up once by the user: `browserkit signin setup bitwarden` (Bitwarden's
`bw` CLI) or `signin setup proton` (Proton Pass's `pass-cli`).

A password you type yourself (a new account), by fill or keyboard, is saved to that manager once
the form goes through, and the submitting click's `[ok]` line says so: saved, being saved, or (with
none set up) whether the user clicked Save in Chrome's prompt when Aeon asked. That line is the
answer: never log out, reopen the form or look for the login elsewhere to check it. If the user did
not confirm Chrome's prompt, say in your answer that the login may not be saved.

Do it yourself first, every time: sign-in with `bu.signIn()`, codes with `bu.fillCode()`, banners
and pop-ups with `page.overlays.dismiss()`, a checkbox check with one click like a person. Hand
back with `bu.handoff("...")` only for what is left: a code that never arrived, a passkey or
approval on the user's device, a payment confirmation, a check that is still there after your
try, or a choice that is theirs. Before a click that opens a passkey or 2FA prompt the page
blocks on, start it first with `{start: true}` (help('signin')).

A bot wall (Cloudflare, DataDome and the like) logs a `[warn] challenge:` line when the page opens.
Try its checkbox once (`clickAt` on it); if the check is still there,
`await bu.handoff("Please finish the check", {wait: true})` returns once the page is clear. To reuse the signed-in session from a script, `browserkit session export
<site>` or `browserkit cookies export <site>` saves the cookies, mapped site or not.
`help('gated')`.
