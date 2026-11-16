import { db } from "./firebase-config.js";
import { getAuth, signInWithEmailAndPassword, signOut } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import { doc, getDoc } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
const auth=getAuth();const $=id=>document.getElementById(id);
const panels={free:$("freePanel"),subscribed:$("subscriberForm"),admin:$("adminPanel")};
document.querySelectorAll(".choice").forEach(button=>button.addEventListener("click",()=>{
 document.querySelectorAll(".choice").forEach(b=>b.classList.toggle("active",b===button));
 Object.entries(panels).forEach(([role,panel])=>panel.hidden=role!==button.dataset.role);
 $("message").textContent="";
}));
$("continueFree").addEventListener("click",async()=>{
 $("message").textContent="";$("continueFree").disabled=true;
 try {if(auth.currentUser && !auth.currentUser.isAnonymous) await signOut(auth);window.location.assign("parking.html");}
 catch(error){$("message").textContent="Could not switch accounts: "+error.message;$("continueFree").disabled=false;}
});
$("subscriberForm").addEventListener("submit",async event=>{
 event.preventDefault();const button=$("subscriberSubmit");button.disabled=true;$("message").textContent="Checking subscription…";
 try {
  const credential=await signInWithEmailAndPassword(auth,$("subscriberEmail").value.trim(),$("subscriberPassword").value);
  const snapshot=await getDoc(doc(db,"users",credential.user.uid));
  const data=snapshot.exists()?snapshot.data():{};
  // Subscription is controlled by trusted Firebase data, never a client-side role selection.
  if(data.subscriptionStatus!=="active"){
    await signOut(auth);$("message").textContent="No active subscription found for this account. Choose Free user or contact your project administrator.";return;
  }
  window.location.assign("parking.html");
 }catch(error){$("message").textContent="Sign-in failed: "+error.message;}
 finally{button.disabled=false;}
});
