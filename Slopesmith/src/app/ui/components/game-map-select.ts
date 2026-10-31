import { mapDisplayName, mapGame, mapGameLabel, type MapSourceChoice } from '../../../core/reference/map-game';
import { findMapChoice, splitMapSource, type MapSource } from '../../../core/reference/map-source';
import { registerMapSources } from '../../state/map-sources';
import { assetLocation } from '../../net/asset-versions';

const sourceOf = (map: MapSourceChoice): MapSource => map.source ?? splitMapSource(map.name).source ?? 'server';

/** Source → Game → Map over stable identities; programmatic picks switch all controls together. */
export class GameMapSelect {
  readonly sourceSelect = document.createElement('select');
  readonly gameSelect = document.createElement('select');
  readonly controls: readonly HTMLLabelElement[];
  private maps: MapSourceChoice[] = [];
  private remembered = new Map<string, string>();
  private rememberedGame = new Map<string, string>();

  constructor(
    readonly mapSelect: HTMLSelectElement,
    private context: string,
    private changed: (name: string) => void,
    private none?: string,
  ) {
    this.sourceSelect.setAttribute('aria-label', `${context} source`);
    this.gameSelect.setAttribute('aria-label', `${context} game`);
    mapSelect.setAttribute('aria-label', `${context} map`);
    this.controls = [
      this.control('Source', this.sourceSelect),
      this.control('Game', this.gameSelect),
      this.control('Map', mapSelect),
    ];
    this.sourceSelect.onchange = () => {
      this.fillGames(this.rememberedGame.get(this.sourceSelect.value) ?? this.gameSelect.value);
      this.rememberedGame.set(this.sourceSelect.value, this.gameSelect.value);
      this.fillMaps(this.remembered.get(this.selectionKey()) ?? this.none ?? '');
      this.changed(mapSelect.value);
    };
    this.gameSelect.onchange = () => {
      this.rememberedGame.set(this.sourceSelect.value, this.gameSelect.value);
      this.fillMaps(this.remembered.get(this.selectionKey()) ?? this.none ?? '');
      this.changed(mapSelect.value);
    };
    mapSelect.onchange = () => {
      this.remembered.set(this.selectionKey(), mapSelect.value);
      this.changed(mapSelect.value);
    };
  }

  private selectionKey(): string {
    return `${this.sourceSelect.value}:${this.gameSelect.value}`;
  }
  private control(title: string, select: HTMLSelectElement): HTMLLabelElement {
    const label = document.createElement('label');
    label.className = 'sp-game-map-control';
    label.style.cssText = 'display:inline-flex;align-items:center;gap:5px;min-width:0';
    const name = document.createElement('span');
    name.textContent = title;
    select.style.maxWidth = '210px';
    label.append(name, select);
    return label;
  }
  get levels(): string[] {
    return this.maps.map(map => map.name);
  }
  has(name: string): boolean {
    return !!findMapChoice(this.maps, assetLocation(name) ?? name);
  }
  setMaps(maps: readonly MapSourceChoice[], preferred?: string): void {
    this.maps = [...new Map(maps.map(map => [map.name, map])).values()];
    registerMapSources(this.context, this.maps);
    const sources = (['local', 'server'] as const).filter(source => this.maps.some(map => sourceOf(map) === source));
    this.sourceSelect.replaceChildren();
    for (const source of sources) this.sourceSelect.add(new Option(source === 'local' ? 'Local' : 'Server', source));
    this.sourceSelect.disabled = sources.length === 0;
    this.controls[0].hidden = sources.length <= 1;
    this.controls[0].style.display = sources.length <= 1 ? 'none' : 'inline-flex';
    this.select(preferred ?? this.none ?? this.maps[0]?.name ?? '');
  }
  select(name: string): void {
    name = assetLocation(name) ?? name;
    const requestedSource = splitMapSource(name).source;
    const map = findMapChoice(this.maps, name) ?? (this.none || requestedSource ? undefined : this.maps[0]);
    if (!map && requestedSource) {
      this.sourceSelect.value = requestedSource;
      this.fillGames();
      this.gameSelect.value = '';
      this.fillMaps(this.none ?? '');
      return;
    }
    if (map) {
      this.sourceSelect.value = sourceOf(map);
      this.rememberedGame.set(this.sourceSelect.value, mapGame(map));
      this.fillGames(mapGame(map));
      this.remembered.set(this.selectionKey(), map.name);
    } else this.fillGames(this.rememberedGame.get(this.sourceSelect.value));
    this.fillMaps(map?.name ?? this.none ?? '');
  }
  rename(name: string, label: string): void {
    const map = findMapChoice(this.maps, name);
    if (!map || map.label === label) return;
    map.label = label;
    registerMapSources(this.context, this.maps);
    this.fillMaps(this.mapSelect.value);
  }
  private fillGames(preferred?: string): void {
    const games = [...new Set(this.maps.filter(map => sourceOf(map) === this.sourceSelect.value).map(mapGame))].sort(
      (a, b) =>
        a === 'slopesmith'
          ? -1
          : b === 'slopesmith'
            ? 1
            : a === 'unknown'
              ? 1
              : b === 'unknown'
                ? -1
                : mapGameLabel(a).localeCompare(mapGameLabel(b)),
    );
    this.gameSelect.replaceChildren();
    if (this.none) this.gameSelect.add(new Option('Choose game', ''));
    for (const game of games) this.gameSelect.add(new Option(mapGameLabel(game), game));
    if (preferred && games.includes(preferred)) this.gameSelect.value = preferred;
    this.gameSelect.disabled = games.length === 0;
  }
  private fillMaps(selected: string): void {
    this.mapSelect.replaceChildren();
    if (this.none) this.mapSelect.add(new Option(this.none, this.none));
    for (const map of this.maps.filter(
      map => sourceOf(map) === this.sourceSelect.value && mapGame(map) === this.gameSelect.value,
    ))
      this.mapSelect.add(new Option(map.label ?? mapDisplayName(map), map.name));
    if ([...this.mapSelect.options].some(option => option.value === selected)) this.mapSelect.value = selected;
    this.mapSelect.disabled =
      this.mapSelect.options.length === 0 || (this.none !== undefined && !this.gameSelect.value);
  }
}
