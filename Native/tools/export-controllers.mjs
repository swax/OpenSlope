// Bake requested first-party art through its public API. Player builds embed the
// saved GLB; the authoring application's runtime is never linked or packaged.
import { build } from '../../Slopesmith/node_modules/esbuild/lib/main.js';
import { chromium } from '../../Slopesmith/node_modules/playwright-core/index.mjs';
import { createServer } from 'node:http';
import { existsSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const source = `
import * as THREE from 'three';
import { createVirtualController } from './src/app/ride/xr/session';
const art = createVirtualController();
art.setHandedness('right');
art.group.updateMatrixWorld(true);
const values = [], parts = [];
art.group.traverse(node => {
  if (!node.isMesh) return;
  const geometry = node.geometry, position = geometry.getAttribute('position'), normal = geometry.getAttribute('normal');
  const colours = geometry.getAttribute('color');
  const materials = Array.isArray(node.material) ? node.material : [node.material];
  const indices = geometry.index?.array ?? Array.from({length:position.count}, (_,i)=>i);
  parts.push({name:node.name, first:values.length / 9, count:indices.length});
  for(let k=0;k<indices.length;++k) {
    const i=Number(indices[k]), group=geometry.groups.find(g=>k>=g.start && k<g.start+g.count);
    const material=materials[group?.materialIndex ?? 0] ?? materials[0];
    if(material.map || material.opacity!==1) throw Error('Controller bake requires opaque first-party mesh art');
    const p=new THREE.Vector3().fromBufferAttribute(position,i).applyMatrix4(node.matrixWorld);
    const n=new THREE.Vector3().fromBufferAttribute(normal,i).transformDirection(node.matrixWorld);
    const rgb=material.color.toArray();
    if(material.vertexColors && colours) for(let c=0;c<3;++c) rgb[c]*=colours.array[i*colours.itemSize+c];
    values.push(...p.toArray(),...rgb,...n.toArray());
  }
});
art.dispose();
window.controllerArt={values,parts};
`;
const bundle = await build({stdin:{contents:source,resolveDir:fileURLToPath(new URL('../../Slopesmith',import.meta.url)),loader:'ts'},bundle:true,write:false,format:'esm',platform:'browser',logLevel:'silent'});
const server=createServer((request,response)=>{
  response.setHeader('content-type',request.url==='/art.js'?'text/javascript':'text/html');
  response.end(request.url==='/art.js'?bundle.outputFiles[0].text:'<!doctype html><script type="module" src="/art.js"></script>');
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
let browser;
try {
  const executablePath=[process.env.SLOPESMITH_CHROMIUM,'C:/Program Files/Google/Chrome/Application/chrome.exe','C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(path=>path&&existsSync(path));
  browser=await chromium.launch({executablePath,headless:true});
  const page=await browser.newPage(),errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.goto('http://127.0.0.1:'+server.address().port);
  await page.waitForFunction(()=>window.controllerArt,{}, {timeout:15000}).catch(()=>{throw Error(errors.join('\n'));});
  const {values,parts}=await page.evaluate(()=>window.controllerArt);
  const count=values.length/9,binary=Buffer.alloc(values.length*4),low=[Infinity,Infinity,Infinity],high=[-Infinity,-Infinity,-Infinity];
  values.forEach((value,i)=>{if(!Number.isFinite(value))throw Error('Invalid art coordinate');binary.writeFloatLE(value,i*4);if(i%9<3){const c=i%9;low[c]=Math.min(low[c],value);high[c]=Math.max(high[c],value);}});
  const metadata={asset:{version:'2.0',generator:'OpenSlope first-party controller art bake',copyright:'OpenSlope contributors; Apache-2.0'},scene:0,scenes:[{nodes:[0]}],nodes:[{name:'Quest Touch Plus in OpenXR grip space',mesh:0}],meshes:[{primitives:[{attributes:{POSITION:0,COLOR_0:1,NORMAL:2},mode:4}],extras:{parts}}],buffers:[{byteLength:binary.length}],bufferViews:[{buffer:0,byteOffset:0,byteLength:binary.length,byteStride:36,target:34962}],accessors:[0,12,24].map((byteOffset,i)=>({bufferView:0,byteOffset,componentType:5126,count,type:'VEC3',...(i===0?{min:low,max:high}:{})}))};
  const json=Buffer.from(JSON.stringify(metadata)),padded=Buffer.alloc(Math.ceil(json.length/4)*4,32);json.copy(padded);
  const header=Buffer.alloc(20),chunk=Buffer.alloc(8);
  header.writeUInt32LE(0x46546c67);header.writeUInt32LE(2,4);header.writeUInt32LE(28+padded.length+binary.length,8);header.writeUInt32LE(padded.length,12);header.writeUInt32LE(0x4e4f534a,16);
  chunk.writeUInt32LE(binary.length);chunk.writeUInt32LE(0x004e4942,4);
  const path=process.argv[2]??fileURLToPath(new URL('../assets/quest-touch-plus.glb',import.meta.url));
  writeFileSync(path,Buffer.concat([header,padded,chunk,binary]));
  console.log('Saved '+count/3+' first-party controller triangles in '+parts.length+' parts to '+path);
} finally {await browser?.close();server.close();}
