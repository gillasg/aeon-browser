// What Aeon can do, in the user's words, for the Learn page. Each entry has an example that
// "Try it" puts in the ask box. Kept in step with the feature list: a new user-visible feature
// that someone would ask for gets an entry here in the same change.

export type LearnTopic = "browse" | "watch" | "sites" | "shortcuts";

export interface LearnItem {
  title: string;
  body: string;
  example: string;
  topic: LearnTopic;
}

export const LEARN_TOPICS: ReadonlyArray<readonly [LearnTopic | "all", string]> = [
  ["all", "All"],
  ["browse", "Browse"],
  ["watch", "Watch"],
  ["sites", "Sites"],
  ["shortcuts", "Shortcuts"],
];

export const LEARN_ITEMS: readonly LearnItem[] = [
  {
    topic: "browse",
    title: "Work in your own Chrome",
    body: "Aeon uses your real tabs, signed in as you. No copy-pasting between apps.",
    example: "Find my unread LinkedIn messages and draft a short reply to each",
  },
  {
    topic: "browse",
    title: "Read a page into a table",
    body: "Results, listings and feeds come back as clean rows you can sort and compare.",
    example:
      "Search Amazon for noise-cancelling headphones and list the top 20 with price and rating",
  },
  {
    topic: "browse",
    title: "Read a whole site",
    body: "Every page of a docs site or blog, turned into one tidy Markdown file.",
    example: "Turn the Tailwind CSS docs into one Markdown file",
  },
  {
    topic: "browse",
    title: "Fill long forms",
    body: "Fifteen fields, dropdowns and date pickers filled in one go. It stops before anything is sent.",
    example: "Fill in the job application I have open using my resume",
  },
  {
    topic: "browse",
    title: "Research in the background",
    body: "Aeon opens its own tabs out of your way and closes them when it's done.",
    example: "Compare the five most popular note-taking apps: price, offline support and sharing",
  },
  {
    topic: "browse",
    title: "Check hundreds of links",
    body: "A long list of sites sorted into live, parked, dead and signed-in only.",
    example: "Check these links and tell me which are dead: ",
  },
  {
    topic: "browse",
    title: "Find what you read before",
    body: "Your history, bookmarks and open tabs are searchable by what they were about.",
    example: "Find the article about rate limits I read last week",
  },
  {
    topic: "browse",
    title: "Ask several AIs at once",
    body: "ChatGPT, Gemini, Grok, Perplexity and Kimi in your own accounts, answers side by side.",
    example:
      "Ask ChatGPT, Gemini and Perplexity which laptop to buy for travel and compare their answers",
  },
  {
    topic: "browse",
    title: "Ask about a video",
    body: "Questions about a YouTube video, answered with the moment it happens.",
    example: "In the YouTube video I have open, when does he explain the formula?",
  },
  {
    topic: "browse",
    title: "Save images and files",
    body: "Every photo in a post or gallery saved to a folder, and files dropped into any uploader.",
    example: "Save every image from the Instagram post I have open",
  },
  {
    topic: "watch",
    title: "Tell me when it changes",
    body: "Aeon checks a page for you and only tells you about what's new.",
    example: "Tell me when a new apartment under $2,000 is listed on Zillow in Mission District",
  },
  {
    topic: "watch",
    title: "Run it every day",
    body: "A task on a schedule, in your browser, while you get on with your day.",
    example: "Every morning at 8, check my visa appointment portal and tell me if a slot opens",
  },
  {
    topic: "watch",
    title: "Pin an answer to Home",
    body: "A number you check often, kept current on Home.",
    example: "Pin my next flight's departure time to Home",
  },
  {
    topic: "watch",
    title: "Repeat a chore without AI",
    body: "Once Aeon knows the steps, a routine runs them with no model calls at all.",
    example: "Fill in my timesheet every Friday at 5pm",
  },
  {
    topic: "sites",
    title: "Gets faster on sites you use",
    body: "Aeon learns a site's own data calls as it works, so the next time takes seconds.",
    example: "Get my last 50 Amazon orders as a table",
  },
  {
    topic: "sites",
    title: "Make a one-tap action",
    body: "Describe it once and Aeon builds and tests an action you can run any time.",
    example: "Make me a 'prescription ready?' check for my pharmacy",
  },
  {
    topic: "sites",
    title: "Show it once",
    body: "Do a task by hand while Aeon watches, then let it do the rest.",
    example: "Watch me file one expense report, then file the other nine",
  },
  {
    topic: "sites",
    title: "Signs in for you",
    body: "Your password manager fills the form, codes included. Aeon never sees the password.",
    example: "Sign in to my electricity account and download the latest bill",
  },
  {
    topic: "sites",
    title: "Find a site's hidden API",
    body: "The data a page loads, found and replayed with new values.",
    example:
      "Find the API behind Google Flights and get prices to Tokyo for every weekend in March",
  },
  {
    topic: "shortcuts",
    title: "Call Aeon on any page",
    body: "Ctrl+Shift+Space opens Aeon with the page you're on as context.",
    example: "Summarise the page I have open in five bullets",
  },
  {
    topic: "shortcuts",
    title: "Change how a site looks",
    body: "Hide what you never use or add what's missing, and it stays that way.",
    example: "Hide Shorts on YouTube",
  },
  {
    topic: "shortcuts",
    title: "Clear the clutter",
    body: "Cookie banners, newsletter pop-ups and overlays, gone in one step.",
    example: "Open the New York Times homepage and clear every pop-up",
  },
  {
    topic: "shortcuts",
    title: "Record what it does",
    body: "A clean video of the run, with no Aeon controls in the shot.",
    example:
      "Book a table for two on OpenTable and record it as a video, stopping before you confirm",
  },
  {
    topic: "shortcuts",
    title: "Use it from the terminal",
    body: "aeon run starts a chat from any shell; coding agents use it too.",
    example: "Find my last Uber receipt",
  },
];
