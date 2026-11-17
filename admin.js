import { db } from "./firebase-config.js";
import { getAuth, signInWithEmailAndPassword, signOut, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import { collection, doc, addDoc, getDoc, onSnapshot, updateDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
const auth=getAuth();let unsub=null;
const radiusPreviewMaps=new Set();
function disposeRadiusPreviews(){for(const map of radiusPreviewMaps){map.remove();}radiusPreviewMaps.clear();}
const adminTabs=document.querySelectorAll(".admin-tab");
function showAdminView(view){
 const sections={map:"adminMapView",manage:"adminManageView",presentation:"adminPresentationView",about:"adminAboutView"};
 if(!sections[view]) view="map";
 for(const [key,id] of Object.entries(sections)) $(id).hidden=key!==view;
 adminTabs.forEach(button=>{const selected=button.dataset.view===view;button.classList.toggle("active",selected);button.setAttribute("aria-pressed",String(selected));});
}
adminTabs.forEach(button=>button.addEventListener("click",()=>showAdminView(button.dataset.view)));
function loadAdminMap(){const frame=$("adminParkingFrame");if(frame && frame.getAttribute("src")==="about:blank")frame.src=frame.dataset.src;}
const $=id=>document.getElementById(id);
// Presentation-only controls for the login form. Firebase authorization is unchanged.
const adminPasswordToggle = $("toggleAdminPassword");
adminPasswordToggle.addEventListener("click", () => {
  const input = $("password");
  const reveal = input.type === "password";
  input.type = reveal ? "text" : "password";
  adminPasswordToggle.textContent = reveal ? "Hide" : "Show";
  adminPasswordToggle.setAttribute("aria-label", reveal ? "Hide password" : "Show password");
  adminPasswordToggle.setAttribute("aria-pressed", String(reveal));
});
$("loginForm").addEventListener("submit",async e=>{
  e.preventDefault();
  const button = $("adminLoginSubmit");
  const message = $("loginMessage");
  button.disabled = true;
  button.textContent = "Signing in…";
  message.classList.add("is-loading");
  message.textContent = "Signing in securely…";
  try {
    await signInWithEmailAndPassword(auth,$("email").value,$("password").value);
    message.textContent = "";
  } catch(err) {
    console.error("Administrator sign-in failed:",err);
    message.textContent = "Unable to sign in. Please check your email and password.";
  } finally {
    message.classList.remove("is-loading");
    button.disabled = false;
    button.innerHTML = 'Sign in <span aria-hidden="true">→</span>';
  }
});
$("logout").addEventListener("click",()=>signOut(auth));
// Presentation mode is deliberately local to this browser, never written to Firestore.
const PRESENTATION_KEY = "spotitPresentation23";
let presentationZones = [];
function getPresentation() { try { return JSON.parse(localStorage.getItem(PRESENTATION_KEY) || "null") || { enabled:false, zones:{} }; } catch { return {enabled:false,zones:{}}; } }
function savePresentation(x) {
  localStorage.setItem(PRESENTATION_KEY, JSON.stringify(x));
  $("presentationOptions").hidden = !x.enabled;
  $("presentationEnabled").checked = !!x.enabled;
  $("presentationMessage").textContent = x.enabled ? "Sample statuses enabled in this browser only. Firebase data unchanged." : "Live Firebase statuses displayed.";
}
$("presentationEnabled").addEventListener("change", e => { const x=getPresentation(); x.enabled=e.target.checked; savePresentation(x); });
$("presentationPreset").addEventListener("click", () => {
  const x=getPresentation(); x.enabled=true; x.zones={};
  const verified=presentationZones.filter(z=>z.verified && z.capacity>0);
  const all=[...verified,...presentationZones.filter(z=>!z.verified || z.capacity<=0)];
  const statuses=["available","limited","full","unknown"];
  all.slice(0,4).forEach((z,i)=>{x.zones[z.id]=statuses[i];});
  savePresentation(x);
});
$("presentationApply").addEventListener("click",()=>{
  const id=$("presentationZone").value, status=$("presentationStatus").value;
  if(!id)return; const x=getPresentation(); x.enabled=true;
  if(status==="live")delete x.zones[id]; else x.zones[id]=status;
  savePresentation(x);
});
$("presentationClear").addEventListener("click",()=>savePresentation({enabled:false,zones:{}}));
function populatePresentationZones(snapshot) {
  presentationZones=snapshot.docs.map(d=>({id:d.id, name:d.data().zone_name || d.id, verified:d.data().verified===true, capacity:d.data().capacity||0})).sort((a,b)=>a.name.localeCompare(b.name));
  const select=$("presentationZone"), selected=select.value;
  select.replaceChildren();
  for(const z of presentationZones){const opt=document.createElement("option");opt.value=z.id;opt.textContent=z.name;select.appendChild(opt);}
  if(presentationZones.some(z=>z.id===selected))select.value=selected;
}
savePresentation(getPresentation());
onAuthStateChanged(auth,async user=>{
 if(unsub){unsub();unsub=null;}
 disposeRadiusPreviews();
 closeAddZoneForm();
 $("adminPanel").hidden=true;$("loginPanel").hidden=false;const frame=$("adminParkingFrame");if(frame)frame.src="about:blank";
 if(!user)return;
 try{
  const permission=await getDoc(doc(db,"admins",user.uid));
  if(!permission.exists() || permission.data().enabled!==true){console.warn("Admin access not approved for UID:",user.uid);$("loginMessage").textContent="This account does not have administrator access. Please contact the project administrator.";return;}
  $("loginPanel").hidden=true;$("adminPanel").hidden=false;$("loginMessage").textContent="";showAdminView("map");loadAdminMap();
  unsub=onSnapshot(collection(db,"zones"),snapshot=>{
   populatePresentationZones(snapshot);
   const container=$("zones");disposeRadiusPreviews();container.replaceChildren();
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
 const radius=field("GPS check-in radius (metres)",data.radius??150,"number");radius.min="10";radius.max="300";radius.step="1";
 const lat=field("Latitude (surveyed)",data.latitude,"number",false);lat.step="any";lat.min="-90";lat.max="90";
 const lng=field("Longitude (surveyed)",data.longitude,"number",false);lng.step="any";lng.min="-180";lng.max="180";
 const check=document.createElement("label");check.className="check";const verified=document.createElement("input");verified.type="checkbox";verified.checked=data.verified===true;check.append(verified,document.createTextNode("I verified the parking capacity and coordinates"));
 const note=document.createElement("p");note.className="note";note.textContent="Only enable verification after surveying this actual parking area. Existing coordinates may point to cafes rather than car parks.";
 const save=document.createElement("button");save.type="submit";save.textContent="Save changes";
 const msg=document.createElement("p");msg.setAttribute("role","status");
 // Preview the actual GPS geofence without modifying the zone until Save changes.
 const preview=document.createElement("section");preview.className="radius-preview";
 const previewHeading=document.createElement("div");previewHeading.className="radius-preview-heading";
 const previewTitle=document.createElement("strong");previewTitle.textContent="GPS check-in area";
 const previewValue=document.createElement("span");previewValue.className="radius-preview-value";
 previewHeading.append(previewTitle,previewValue);
 const previewMap=document.createElement("div");previewMap.className="radius-preview-map";previewMap.setAttribute("aria-label","Map showing this parking zone's GPS check-in radius");
 const previewNote=document.createElement("p");previewNote.className="note";previewNote.textContent="The shaded circle shows the allowed check-in distance around the parking marker. Adjust the radius above to preview it; press Save changes to apply it to Firebase.";
 preview.append(previewHeading,previewMap,previewNote);
 form.append(fields,preview,check,note,save,msg);wrap.append(form);
 let map=null,circle=null,marker=null;
 function readCoordinates(){const latitude=Number(lat.value),longitude=Number(lng.value);return lat.value.trim()!==""&&lng.value.trim()!==""&&Number.isFinite(latitude)&&Number.isFinite(longitude)&&Math.abs(latitude)<=90&&Math.abs(longitude)<=180?[latitude,longitude]:null;}
 function refreshRadiusPreview(){
  const coords=readCoordinates();const metres=Number(radius.value);
  previewValue.textContent=Number.isFinite(metres)&&metres>0?`${metres} m radius`:"Invalid radius";
  if(!coords){previewMap.textContent="Enter valid latitude and longitude to display the parking radius.";if(map){map.remove();radiusPreviewMaps.delete(map);map=null;circle=null;marker=null;}return;}
  if(!window.L){previewMap.textContent="Map preview unavailable. Check your internet connection and reload.";return;}
  if(!map){previewMap.replaceChildren();map=L.map(previewMap,{scrollWheelZoom:false}).setView(coords,17);radiusPreviewMaps.add(map);L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",{maxZoom:19,attribution:'&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'}).addTo(map);marker=L.marker(coords).addTo(map);circle=L.circle(coords,{radius:Number.isFinite(metres)&&metres>0?metres:150,color:"#168c5b",weight:2,fillColor:"#2ccf8c",fillOpacity:0.17,interactive:false}).addTo(map);}
  marker.setLatLng(coords);circle.setLatLng(coords);
  if(Number.isFinite(metres)&&metres>0)circle.setRadius(metres);
  map.invalidateSize({pan:false});
  map.fitBounds(circle.getBounds().pad(0.35),{maxZoom:18,animate:false});
  requestAnimationFrame(()=>{if(map)map.invalidateSize({pan:false});});
 }
 toggle.addEventListener("click",()=>{form.hidden=!form.hidden;if(!form.hidden)requestAnimationFrame(refreshRadiusPreview);});
 [radius,lat,lng].forEach(input=>input.addEventListener("input",()=>{if(!form.hidden)refreshRadiusPreview();}));
 form.addEventListener("submit",async e=>{e.preventDefault();const count=Number(capacity.value),radiusValue=Number(radius.value),latitude=lat.value.trim()===""?null:Number(lat.value),longitude=lng.value.trim()===""?null:Number(lng.value);
 if(!Number.isInteger(radiusValue)||radiusValue<10||radiusValue>300 ){msg.textContent="GPS radius must be a whole number from 10 to 300 metres.";return;}
 if(!Number.isInteger(count)||count<0|| (latitude!==null&&(!Number.isFinite(latitude)||Math.abs(latitude)>90))||(longitude!==null&&(!Number.isFinite(longitude)||Math.abs(longitude)>180))){msg.textContent="Invalid capacity or coordinates";return;}
 if(verified.checked && (count<=0||latitude===null||longitude===null)){msg.textContent="A verified location requires a positive capacity and both coordinates.";return;}
 save.disabled=true;try{await updateDoc(doc(db,"zones",item.id),{zone_name:title.value.trim(),capacity:count,radius:radiusValue,latitude,longitude,verified:verified.checked,updatedAt:serverTimestamp()});msg.textContent="Saved";}catch(err){msg.textContent="Save failed: "+err.message;}finally{save.disabled=false;}
 });return wrap;
}

// Update 13: create a new parking zone using an interactive map.
let newZoneMap=null, newZoneMarker=null, newZoneCircle=null;
const addZoneToggle=$("addZoneToggle"), addZonePanel=$("addZonePanel");
const addZoneForm=$("addZoneForm"), newLat=$("newZoneLatitude"), newLng=$("newZoneLongitude"), newRadius=$("newZoneRadius");
function closeAddZoneForm(){
 addZonePanel.hidden=true;addZoneToggle.setAttribute("aria-expanded","false");
 if(newZoneMap){newZoneMap.remove();newZoneMap=null;newZoneMarker=null;newZoneCircle=null;}
}
function newZoneCoordinates(){
 const lat=Number(newLat.value),lng=Number(newLng.value);
 return newLat.value.trim()!==""&&newLng.value.trim()!==""&&Number.isFinite(lat)&&Number.isFinite(lng)&&Math.abs(lat)<=90&&Math.abs(lng)<=180?[lat,lng]:null;
}
function refreshNewZoneMap(recenter=false){
 if(!newZoneMap)return;
 const coords=newZoneCoordinates();
 if(!coords){if(newZoneMarker){newZoneMap.removeLayer(newZoneMarker);newZoneMarker=null;}if(newZoneCircle){newZoneMap.removeLayer(newZoneCircle);newZoneCircle=null;}return;}
 const r=Number(newRadius.value),radius=Number.isFinite(r)&&r>=10&&r<=300?r:150;
 if(!newZoneMarker)newZoneMarker=L.marker(coords,{draggable:true}).addTo(newZoneMap).on("dragend",()=>{const p=newZoneMarker.getLatLng();newLat.value=p.lat.toFixed(7);newLng.value=p.lng.toFixed(7);refreshNewZoneMap();});
 else newZoneMarker.setLatLng(coords);
 if(!newZoneCircle)newZoneCircle=L.circle(coords,{radius,color:"#168c5b",weight:2,fillColor:"#2ccf8c",fillOpacity:0.17,interactive:false}).addTo(newZoneMap);
 else {newZoneCircle.setLatLng(coords);newZoneCircle.setRadius(radius);}
 if(recenter)newZoneMap.fitBounds(newZoneCircle.getBounds().pad(0.4),{maxZoom:18,animate:false});
}
function openAddZoneForm(){
 addZonePanel.hidden=false;addZoneToggle.setAttribute("aria-expanded","true");
 if(!window.L){$("createZoneMessage").textContent="Map unavailable. Check your internet connection; coordinates can still be entered manually.";return;}
 if(!newZoneMap){
  // Initialize only after the container is visible, avoiding Leaflet's undefined map errors.
  newZoneMap=L.map("newZoneMap",{scrollWheelZoom:false}).setView([4.387,100.975],15);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",{maxZoom:19,attribution:'&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'}).addTo(newZoneMap);
  newZoneMap.on("click",e=>{newLat.value=e.latlng.lat.toFixed(7);newLng.value=e.latlng.lng.toFixed(7);refreshNewZoneMap();});
 }
 refreshNewZoneMap(true);
 requestAnimationFrame(()=>{if(newZoneMap)newZoneMap.invalidateSize({pan:false});});
}
addZoneToggle.addEventListener("click",()=>{if(addZonePanel.hidden){openAddZoneForm();addZonePanel.scrollIntoView({behavior:"smooth",block:"nearest"});}else closeAddZoneForm();});
$("cancelZoneButton").addEventListener("click",closeAddZoneForm);
[newLat,newLng,newRadius].forEach(input=>input.addEventListener("input",()=>refreshNewZoneMap(true)));
addZoneForm.addEventListener("submit",async e=>{
 e.preventDefault();
 const msg=$("createZoneMessage"),name=$("newZoneName").value.trim(),capacity=Number($("newZoneCapacity").value),radius=Number(newRadius.value),coords=newZoneCoordinates();
 if(!name||name.length>100||!Number.isInteger(capacity)||capacity<0||!Number.isInteger(radius)||radius<10||radius>300||!coords){msg.textContent="Enter a name, valid capacity, 10–300 m radius in 1 m steps, and a map location.";return;}
 const save=$("createZoneButton");save.disabled=true;msg.textContent="Saving parking zone…";
 try{
  await addDoc(collection(db,"zones"),{zone_name:name,capacity,radius,latitude:coords[0],longitude:coords[1],verified:false,createdAt:serverTimestamp(),updatedAt:serverTimestamp()});
  addZoneForm.reset();newLat.value="";newLng.value="";newRadius.value="150";$("newZoneCapacity").value="0";
  closeAddZoneForm();$("adminMessage").textContent=`${name} added to Firebase as Unverified. Select it below to verify after surveying.`;
 }catch(err){msg.textContent="Could not create parking zone: "+err.message;}
 finally{save.disabled=false;}
});
