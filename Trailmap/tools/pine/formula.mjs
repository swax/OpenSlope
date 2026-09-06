// Numeric check: the closed form transcribed from 0x001cb990 == transpose(Rz*Ry*Rx)
const D=Math.PI/180;
function engine(degX,degY,degZ){
  const ax=-(degX*D), ay=-(degY*D), az=-(degZ*D);      // code negates after deg->rad
  const X1=Math.sin(ax),X2=Math.cos(ax),Y1=Math.sin(ay),Y2=Math.cos(ay),Z1=Math.sin(az),Z2=Math.cos(az);
  return [[Y2*Z2, -Y2*Z1, Y1],
          [X1*Y1*Z2 + X2*Z1, X2*Z2 - X1*Y1*Z1, -X1*Y2],
          [X1*Z1 - X2*Y1*Z2, X2*Y1*Z1 + X1*Z2, X2*Y2]];
}
const Rx=t=>[[1,0,0],[0,Math.cos(t),-Math.sin(t)],[0,Math.sin(t),Math.cos(t)]];
const Ry=t=>[[Math.cos(t),0,Math.sin(t)],[0,1,0],[-Math.sin(t),0,Math.cos(t)]];
const Rz=t=>[[Math.cos(t),-Math.sin(t),0],[Math.sin(t),Math.cos(t),0],[0,0,1]];
const mul=(A,B)=>A.map(r=>[0,1,2].map(j=>r[0]*B[0][j]+r[1]*B[1][j]+r[2]*B[2][j]));
const T=A=>[0,1,2].map(i=>[0,1,2].map(j=>A[j][i]));
let worst=0;
for(let k=0;k<20000;k++){
  const a=[0,0,0].map(()=>Math.random()*720-360);
  const E=engine(a[0],a[1],a[2]);
  const Z=T(mul(mul(Rz(a[2]*D),Ry(a[1]*D)),Rx(a[0]*D)));
  worst=Math.max(worst,Math.max(...E.flatMap((r,i)=>r.map((v,j)=>Math.abs(v-Z[i][j])))));
}
console.log('max |engine_closed_form - transpose(Rz*Ry*Rx)| over 20000 random triples =', worst.toExponential(3));
