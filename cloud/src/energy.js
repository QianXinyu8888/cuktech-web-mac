// Port of ble_server/energy.py. All times are seconds and energy is charger-output Wh.
export const tailThresholdW = peak => Math.max(.05, Math.min(.6, .2 * (peak || 0)));
export const median = a => { if (!a.length) return 0; a=[...a].sort((x,y)=>x-y); const m=a.length>>1; return a.length%2?a[m]:(a[m-1]+a[m])/2; };
export function integrate(points, maxGap=30) { let wh=0; for(let i=1;i<points.length;i++){const dt=points[i].timestamp-points[i-1].timestamp;if(dt>0&&dt<=maxGap) wh+=(points[i-1].voltage*points[i-1].current+points[i].voltage*points[i].current)*dt/7200;} return wh; }
export class ChargeSessionDetector {
 constructor(state={}){Object.assign(this,{samples:[],peak:0,hold:null,grace:0,lastEval:null,lastT:null,lastV:null},state);}
 feed(t,v,i){this.lastT=t;this.lastV=v;this.samples.push([t,Math.max(0,v*i)]);this.samples=this.samples.filter(x=>x[0]>=t-300);if(v<4)this.hold=null;this.peak=Math.max(this.peak,this.fast());}
 since(s){return median(this.samples.filter(x=>x[0]>=this.lastT-s).map(x=>x[1]));}
 fast(){return this.since(20);} slow(){return this.since(180);}
 recovery(){let prev=null,run=0,longest=0;for(const [t,p] of this.samples){if(t<this.lastT-90){prev=t;continue;}const dt=prev===null?0:t-prev;prev=t;if(p>Math.max(5,2*tailThresholdW(this.peak))){run+=Math.max(0,dt);longest=Math.max(longest,run);}else run=0;}return longest;}
 clear(){this.hold=null;this.grace=0;}
 shouldEnd(t,wh,start){if(wh<.05||(start&&t-start<180)){this.clear();return false;}const dt=this.lastEval===null?0:t-this.lastEval;this.lastEval=t;if(this.recovery()>=45){this.clear();return false;}const th=tailThresholdW(this.peak);if(this.fast()<=th&&this.slow()<=th&&this.lastV>=4){if(this.hold===null){this.hold=t;this.grace=0;}}else if(this.hold!==null){this.grace+=Math.max(0,dt);if(this.grace>120){this.clear();return false;}}return this.hold!==null&&t-this.hold>=600;}
}
export class SessionStartGate {
 constructor(state={}){Object.assign(this,{post:false,restart:0,above:null,lastRunStart:null},state);}
 noteEnd(peak){this.post=true;this.restart=Math.max(.4,2*tailThresholdW(peak));this.above=null;}
 noLoad(){this.post=false;this.above=null;}
 shouldStart(t,p,v){const threshold=Math.max(.5,.1*Math.max(0,v),this.post?this.restart:0);if(p<threshold){this.above=null;return false;}if(this.above===null)this.above=t;if(t-this.above<30)return false;this.lastRunStart=this.above;this.above=null;this.post=false;return true;}
}
