// Only built-in Lucide nodes and attributes are serialized here.
export function iconPaths(nodes) {
  return nodes.map(([element, attrs]) => {
    const properties = Object.entries(attrs).map(([name, value]) => `${name}="${value}"`).join(' ');
    return `<${element} ${properties}/>`;
  }).join('');
}
export function iconSvg(paths, attrs = '') {
  return `<svg ${attrs} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
}
