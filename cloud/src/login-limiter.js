// Each object is addressed by an HMAC of client IP; raw addresses are never stored.
export class LoginLimiter {
 constructor(state){this.state=state;}
 async fetch(request){
  const success=(await request.json()).success===true,now=Date.now();
  const result=await this.state.storage.transaction(async storage=>{
   let record=await storage.get('attempts');
   if(!record||record.until<=now)record={count:0,until:now+15*60*1000};
   if(record.count>=5)return {allowed:false,retryAfter:Math.ceil((record.until-now)/1000)};
   if(success)await storage.delete('attempts');
   else{record.count++;await storage.put('attempts',record);await storage.setAlarm(record.until);}
   return {allowed:true};
  });
  return Response.json(result);
 }
 async alarm(){await this.state.storage.deleteAll();}
}
