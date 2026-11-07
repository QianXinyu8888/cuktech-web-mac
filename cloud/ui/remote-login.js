const form=document.querySelector('form'),input=document.querySelector('input'),button=document.querySelector('button'),message=document.querySelector('#message');
form.addEventListener('submit',async e=>{
 e.preventDefault();button.disabled=true;message.textContent='正在验证…';
 try{const r=await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:input.value})});input.value='';
  if(r.ok){location.replace('/');return;}
  message.textContent=r.status===429?'尝试次数过多，请稍后再试。':r.status===401?'访问密码不正确，请重试。':'暂时无法登录，请稍后再试。';
 }catch{message.textContent='网络连接失败，请检查网络后重试。';}finally{button.disabled=false;}
});
