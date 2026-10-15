// Replace with your own Firebase project config (Firebase console > Project settings)
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "YAIzaSyCPtXm3WP2c3HK6yrHS1PqcsZDszVbIaAI",
  authDomain: "campus-parking-2c527.firebaseapp.com",
  projectId: "campus-parking-2c527",
  storageBucket: "campus-parking-2c527.firebasestorage.app",
  messagingSenderId: "967712211990",
  appId: "1:967712211990:web:60d177eab80636d88fa137",
};

export const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
