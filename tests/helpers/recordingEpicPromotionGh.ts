import type { AppEpicPromotionGitHub } from '../../src/main/epicPromotion';

export interface RecordedSubTicket {
  issue: number;
  title: string;
  body: string;
  labels: string[];
}

export function recordingEpicPromotionGh(start = 500): { gh: AppEpicPromotionGitHub; created: () => RecordedSubTicket[] } {
  const tickets: RecordedSubTicket[] = [];
  const labels = new Map<number, string[]>();
  let next = start;
  const gh: AppEpicPromotionGitHub = {
    createIssue: async (title, body) => {
      next += 1;
      tickets.push({ issue: next, title, body, labels: [] });
      return next;
    },
    ensureLabel: async () => {},
    addLabel: async (issue, label) => {
      labels.set(issue, [...(labels.get(issue) ?? []), label]);
    },
    appendIssueBody: async (issue, textToAppend, marker) => {
      const ticket = tickets.find((t) => t.issue === issue);
      if (ticket && !ticket.body.includes(marker)) ticket.body += textToAppend;
    },
    closePr: async () => {},
  };
  return { gh, created: () => tickets.map((t) => ({ ...t, labels: labels.get(t.issue) ?? [] })) };
}
