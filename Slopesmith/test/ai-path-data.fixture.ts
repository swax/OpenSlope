import type { CoursePathFile } from '../src/core/reference/terrain';
import type { MapDataSource } from '../src/shared/map-data';

export const pathFile: CoursePathFile = {
  StartPosList: [1, 2, 1],
  AIPaths: [
    { Name: 'Empty record', PathPoints: [] },
    {
      Name: 'Shared route',
      U3: 80,
      Respawnable: false,
      PathPos: [0, 0, 100],
      PathPoints: [
        [-1000, 0, 100],
        [-1000, 0, -100],
      ],
      PathEvents: [
        { EventType: 100, EventValue: (95 << 2) | 3, EventStart: 500, EventEnd: 700 },
        { EventType: 105, EventValue: 0, EventStart: 800, EventEnd: 900 },
        { EventType: 101, EventValue: 71, EventStart: 1000, EventEnd: 1100 },
        { EventType: 300, EventValue: 0, EventStart: 2000, EventEnd: 2000 },
        { EventType: 777, EventValue: 123, EventStart: 1200, EventEnd: 1300 },
        { EventType: 102, EventValue: 0, EventStart: 1750, EventEnd: 1800 },
      ],
    },
    { Name: 'Shared route', PathPos: [0, 800, 100], PathPoints: [[-2000, 0, 0]] },
  ],
};

export const pathSource: MapDataSource = {
  root: 'maps',
  async readJsonOr<T>(path: string, fallback: T): Promise<T> {
    return path.endsWith('/AIP.json') ? (pathFile as T) : fallback;
  },
  async readTextOrNull() {
    return null;
  },
  async readBytesOrNull() {
    return null;
  },
  async listDir() {
    return [];
  },
  async listEntries() {
    return [];
  },
  async pathExists() {
    return false;
  },
};
