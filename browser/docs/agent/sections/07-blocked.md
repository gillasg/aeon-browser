## Blocked sites

Sites the user blocked are off limits in every way: no tab opens them, `browser.fetch` and site API
calls refuse them, and clicks, redirects or scripts inside a working tab cannot reach them. A call
that touches one fails with `SITE_BLOCKED`: stop, and tell the user if the task needs it. Only the
user changes the list, with `browserkit block|unblock|blocked`.

A routine webhook must be a public `http(s)` address. Local and private addresses are refused when
the routine is saved and again at every send, after the name is looked up: `localhost`,
`127.0.0.1`, private and link-local ranges, and their mapped or numeric spellings. A redirect is
never followed. To reach something on this machine, run a public relay; do not retry another
spelling.
