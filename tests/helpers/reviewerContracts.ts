export const reviewerContracts = [
  { loop: 'sample-loop', persona: 'review-correctness', name: 'sample-loop--review-correctness', charter: 'Check the result against the requested behavior.\n', tools: ['Read', 'Grep'] },
  { loop: 'other-loop', persona: 'review-boundaries', name: 'other-loop--review-boundaries', charter: 'Check that writes stay inside the run folder.\n', tools: 'all' as const },
];
