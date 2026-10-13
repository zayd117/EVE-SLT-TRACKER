// Completion/source fixtures explicitly opt in to the areas they monitor.
// The installed tracker defaults every Lion row to off; controls tests exercise
// that default separately. Existing fixture preferences remain authoritative.
export function withEnabledLionRows(options = {}) {
  const saved = options.localStorage?.lionKingTrackerSettings || {};
  const sections = Object.fromEntries(['b6', 'b7', 'lionking2', 'unassigned']
    .map(area => [area, { show: true, watch: true }]));
  return {
    ...options,
    localStorage: {
      ...options.localStorage,
      lionKingTrackerSettings: {
        lionRowWorkRevision: 1,
        developerMode: true,
        ...saved,
        sections: { ...sections, ...saved.sections }
      }
    }
  };
}
