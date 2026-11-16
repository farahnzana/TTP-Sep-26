import { app } from "./firebase-config.js";
import { getAuth, signOut } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
const auth=getAuth(app);const $=id=>document.getElementById(id);
const panels={free:$("freePanel"),subscribed:$("subscriberForm"),admin:$("adminPanel")};
document.querySelectorAll(".choice").forEach(button=>button.addEventListener("click",()=>{
 document.querySelectorAll(".choice").forEach(b=>b.classList.toggle("active",b===button));
 Object.entries(panels).forEach(([role,panel])=>panel.hidden=role!==button.dataset.role);
 $("message").textContent="";
}));
$("continueFree").addEventListener("click",async()=>{
 $("message").textContent="";$("continueFree").disabled=true;
 try {sessionStorage.removeItem("spotitPlusPreview");if(auth.currentUser && !auth.currentUser.isAnonymous) await signOut(auth);window.location.assign("parking.html");}
 catch(error){$("message").textContent="Could not switch accounts: "+error.message;$("continueFree").disabled=false;}
});
$("subscriberDemo").addEventListener("click", async () => {
 const button = $("subscriberDemo");
 button.disabled = true;
 $("message").textContent = "";
 try {
   // Select the prototype Plus experience; Firebase Auth still owns all bookings.
   if (auth.currentUser && !auth.currentUser.isAnonymous) await signOut(auth);
   sessionStorage.setItem("spotitPlusPreview", "1");
   window.location.assign("parking.html");
 } catch (error) {
   $("message").textContent = "Could not open preview: " + error.message;
   button.disabled = false;
 }
});
