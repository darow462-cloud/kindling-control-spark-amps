// Pure library search/filter helper. No BLE calls and no browser globals.
export function filterOrganizedPresets(presets, filters = {}, profiles = []) {
  const query = String(filters.query ?? '').trim().toLocaleLowerCase();
  const artist = String(filters.artist ?? '');
  const guitarId = String(filters.guitarId ?? '');
  const favoritesOnly = filters.favoritesOnly === true;
  const profileNames = new Map(profiles.map((p) => [p.id, p.name]));

  return presets.filter((preset) => {
    const meta = preset.metadata ?? {};
    if (artist && meta.artist !== artist) return false;
    if (guitarId && meta.guitarProfileId !== guitarId) return false;
    if (favoritesOnly && meta.favorite !== true) return false;
    if (!query) return true;
    const terms = [
      preset.name, preset.description, meta.artist, meta.song,
      ...(Array.isArray(meta.tags) ? meta.tags : []),
      profileNames.get(meta.guitarProfileId),
    ];
    return terms.filter(Boolean).join(' ').toLocaleLowerCase().includes(query);
  });
}
