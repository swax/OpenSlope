/** Project destinations shared by the public toolbar and the editor's About panel. */
export const PROJECT_LINKS = [
  { label: 'GitHub', icon: 'github', href: 'https://github.com/swax/OpenSlope', note: 'source, issues and releases' },
  {
    label: 'Discord',
    icon: 'discord',
    href: 'https://discord.gg/QFnt2x9vZ9',
    note: 'meet other course creators and get help',
  },
] as const;

export const SERVER_SETUP_URL = `${PROJECT_LINKS[0].href}/blob/main/Slopesmith/docs/041-production-deployment.md`;
