export const reviewerContracts = [
  { loop: 'quality-loop', persona: 'check-contracts', charter: 'Return the contract result: cedar.\n', tools: ['Read', 'Grep', 'Glob', 'Bash'] as const },
  { loop: 'quality-loop', persona: 'check-contracts', charter: 'Return the contract result: birch.\n', tools: 'all' as const },
] as const;

export const codexReviewerInstructions = (charter: string): string =>
  `You are a reviewer. Never create, edit or delete any file: report your findings only.\n\n${charter}`;
