/**
 * The PureWire Standard — freedom with a reason.
 *
 * The Standard is the short list of lines the platform draws so everyone's
 * freedom can exist. It is also the vocabulary of moderation: reports,
 * support tickets, and admin actions all cite the specific principle at
 * stake, so every decision traces back to a stated rule.
 */

export interface StandardPrinciple {
  /** Stable machine id — stored on tickets and user moderation records. */
  id: string;
  /** The rule as it appears on the platform. */
  title: string;
  /** One-line explanation of what it protects. */
  detail: string;
}

export const STANDARD_PRINCIPLES: StandardPrinciple[] = [
  {
    id: "say-what-you-mean",
    title: "Say what you mean.",
    detail: "Express yourself honestly — that's the whole point.",
  },
  {
    id: "create-what-you-want",
    title: "Create what you want.",
    detail: "Your work, your words, your way. Nothing forced.",
  },
  {
    id: "find-your-people",
    title: "Find your people.",
    detail: "Follow who matters to you and build your own circle.",
  },
  {
    id: "disagree-without-destroying",
    title: "Disagree without destroying each other.",
    detail: "Push back hard on ideas. Never on people.",
  },
  {
    id: "no-impersonation",
    title: "Don't impersonate people.",
    detail: "Real names for real humans. No pretending to be someone else.",
  },
  {
    id: "no-stolen-work",
    title: "Don't steal people's work.",
    detail: "Every post is verified original. Credit is owed, not optional.",
  },
  {
    id: "no-spam",
    title: "Don't spam the platform.",
    detail: "Share what matters. Repetition and clutter crowd out real voices.",
  },
  {
    id: "no-taking-freedom",
    title:
      "Don't use freedom as an excuse to take someone else's freedom away.",
    detail: "Harassment, doxxing, and intimidation end where your freedom begins.",
  },
  {
    id: "no-ai-content",
    title: "No AI-generated content.",
    detail:
      "Say it yourself. Text, images, audio, and video must be made by human hands.",
  },
];

/** Look up a principle by its stable id. */
export function standardById(
  id: string | null | undefined,
): StandardPrinciple | undefined {
  return STANDARD_PRINCIPLES.find((p) => p.id === id);
}

/** True when a value is a known PureWire Standard principle id. */
export function isStandardId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    STANDARD_PRINCIPLES.some((p) => p.id === value)
  );
}
