import { normalizeParticleVolumes } from '../src/core/particles/volumes';
// tier: fast
import type { EditDoc } from '../src/core/doc/doc-edit';
import type { ExportProvider } from '../src/core/export/provider';
import assert from 'node:assert/strict';
import { blankMountain } from '../src/core/doc/mountain';
import { buildExportFolder } from '../src/core/export/folder';
import { authoredParticleTextures } from '../src/core/effects/particle-textures';
import { createEmptyEffectsDocument } from '../src/core/effects/authoring';
const calls: string[] = [];
const provider = {
  groupDefs: async () => new Map(), modelGeometry: async () => () => ({ subs: [] }),
  materialTables: async () => new Map(), importedProps: async () => ({ models: [], instances: [] }),
  nativeArt: async () => ({ rail: null, gem: null }),
  referenceTexture: async (level: string,name: string) => { calls.push(level+'/'+name); return new Uint8Array([23,51,99]); },
  particleTexture: async () => { throw new Error('Custom fog requested native particle art'); },
  soundIndex: async () => null, environmentEffectSound: async () => new Uint8Array(),
  skybox: async () => ({ files: [], log: [] }),
  discRecipePaths: async () => ({ exportDir: 'PARTICLETEST', levelData: 'Maps/DONOR', levelDataRelative: '../DONOR' }),
  stageRaceMusic: async () => ({ status: 'cleared', files: [], remove: [] }),
} as unknown as ExportProvider;
const effects=createEmptyEffectsDocument('PARTICLETEST');
effects.extensions={slopesmith:{particleTextures:{part:'Custom/spark.png',bad:'GARI/part.png'}}};
assert.deepEqual(authoredParticleTextures(effects),{part:'Custom/spark.png'});
const doc={...blankMountain('PARTICLETEST'),environmentBed:null,effects,particleVolumes:[{
 id:'volume:0',name:'Original fog',pos:[0,0,0],nativeRotation:[0,0,0,1],scale:[1,1,1],
 boundsOffsetMin:[-100,-100,-100],boundsOffsetMax:[100,100,100],unknownInts:[0,0,0,0,0],
 objects:[{boundsMin:[-100,-100,-100],boundsMax:[100,100,100],objectU1:2914832,puffs:[{position:[0,0,0],scale:[1,1,1],radius:100}]}],texture:'Custom/fog.png'}]} as unknown as EditDoc;
doc.particleVolumes=normalizeParticleVolumes(JSON.parse(JSON.stringify(doc.particleVolumes)));
assert.equal(doc.particleVolumes[0].texture,'Custom/fog.png');
const folder=await buildExportFolder(doc,provider,{lighting:false});
assert(calls.includes('Custom/spark.png')&&calls.includes('Custom/fog.png'));
for(const name of ['part','fog0'])assert.deepEqual(folder.files.find(file=>file.path==='Textures/Particles/'+name+'.png')?.bytes,new Uint8Array([23,51,99]));
doc.particleVolumes!.push({...doc.particleVolumes![0],id:'volume:1',texture:'Custom/other.png'});
await assert.rejects(()=>buildExportFolder(doc,provider,{lighting:false}),/one fog0 slot/);
console.log('PASS original particle export bytes, no native fog request, mixed-fog rejection');
