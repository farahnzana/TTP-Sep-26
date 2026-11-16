import { db } from "./firebase-config.js";
import { getAuth, signInWithEmailAndPassword, signOut, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import { collection, doc, getDoc, onSnapshot, updateDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
const auth=getAuth();let unsub=null;
const adminTabs=document.querySelectorAll(".admin-tab");
function showAdminView(view){
 const isMap=view==="map";
 $("adminMapView").hidden=!isMap;$("adminManageView").hidden=isMap;
 adminTabs.forEach(button=>{const selected=button.dataset.view===view;button.classList.toggle("active",selected);button.setAttribute("aria-pressed",String(selected));});
 if(isMap){const frame=$("parkingFrame");if(!frame.src)frame.src=frame.dataset.src;}
}
adminTabs.forEach(button=>button.addEventListener("click",()=>showAdminView(button.dataset.view)));
const $=id=>document.getElementById(id);
$("loginForm").addEventListener("submit",async e=>{e.preventDefault();$("loginMessage").textContent="Signing in…";try{await signInWithEmailAndPassword(auth,$("email").value,$("password").value);$("loginMessage").textContent="";}catch(err){$("loginMessage").textContent=err.message;}});
$("logout").addEventListener("click",()=>signOut(auth));
onAuthStateChanged(auth,async user=>{
 if(unsub){unsub();unsub=null;}
 $("adminPanel").hidden=true;$("loginPanel").hidden=false;$("parkingFrame").removeAttribute("src");
 if(!user)return;
 try{
  const permission=await getDoc(doc(db,"admins",user.uid));
  if(!permission.exists() || permission.data().enabled!==true){$("loginMessage").textContent="This account is not approved. An owner must create admins/"+user.uid+" with enabled: true in Firestore.";return;}
  $("loginPanel").hidden=true;$("adminPanel").hidden=false;$("loginMessage").textContent="";showAdminView("map");
  unsub=onSnapshot(collection(db,"zones"),snapshot=>{
   const container=$("zones");container.replaceChildren();
   const items=snapshot.docs.sort((a,b)=>a.data().zone_name.localeCompare(b.data().zone_name,undefined,{numeric:true}));
   for(const item of items)container.appendChild(zoneCard(item));
  },err=>{$("adminMessage").textContent=err.message;});
 }catch(err){$("loginMessage").textContent=err.message;}
});
function zoneCard(item){
 const data=item.data(), wrap=document.createElement("article");wrap.className="zone";
 const toggle=document.createElement("button");toggle.type="button";toggle.className="zone-summary";
 const name=document.createElement("strong");name.textContent=data.zone_name;
 const status=document.createElement("span");status.textContent=data.verified?`Verified · ${data.capacity} spaces`:"Unverified";
 toggle.append(name,status);wrap.append(toggle);
 const form=document.createElement("form");form.className="zone-form";form.hidden=true;
 const fields=document.createElement("div");fields.className="fields";
 function field(label,value,type="text",required=true){const l=document.createElement("label");l.textContent=label;const inp=document.createElement("input");inp.type=type;inp.value=value??"";inp.required=required;l.append(inp);fields.append(l);return inp;}
 const title=field("Location name",data.zone_name);
 const capacity=field("Total spaces",data.capacity??0,"number");capacity.min="0";capacity.step="1";
 const lat=field("Latitude (surveyed)",data.latitude,"number",false);lat.step="any";lat.min="-90";lat.max="90";
 const lng=field("Longitude (surveyed)",data.longitude,"number",false);lng.step="any";lng.min="-180";lng.max="180";
 const check=document.createElement("label");check.className="check";const verified=document.createElement("input");verified.type="checkbox";verified.checked=data.verified===true;check.append(verified,document.createTextNode("I verified the parking capacity and coordinates"));
 const note=document.createElement("p");note.className="note";note.textContent="Only enable verification after surveying this actual parking area. Existing coordinates may point to cafes rather than car parks.";
 const save=document.createElement("button");save.type="submit";save.textContent="Save changes";
 const msg=document.createElement("p");msg.setAttribute("role","status");
 form.append(fields,check,note,save,msg);wrap.append(form);
 toggle.addEventListener("click",()=>{form.hidden=!form.hidden;});
 form.addEventListener("submit",async e=>{e.preventDefault();const count=Number(capacity.value),latitude=lat.value.trim()===""?null:Number(lat.value),longitude=lng.value.trim()===""?null:Number(lng.value);
 if(!Number.isInteger(count)||count<0|| (latitude!==null&&(!Number.isFinite(latitude)||Math.abs(latitude)>90))||(longitude!==null&&(!Number.isFinite(longitude)||Math.abs(longitude)>180))){msg.textContent="Invalid capacity or coordinates";return;}
 if(verified.checked && (count<=0||latitude===null||longitude===null)){msg.textContent="A verified location requires a positive capacity and both coordinates.";return;}
 save.disabled=true;try{await updateDoc(doc(db,"zones",item.id),{zone_name:title.value.trim(),capacity:count,latitude,longitude,verified:verified.checked,updatedAt:serverTimestamp()});msg.textContent="Saved";}catch(err){msg.textContent="Save failed: "+err.message;}finally{save.disabled=false;}
 });return wrap;
}
