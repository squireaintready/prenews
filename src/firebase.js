import { initializeApp } from 'firebase/app';
import { getFirestore } from 'firebase/firestore';

const firebaseConfig = {
  apiKey: "AIzaSyDvR8TRhb6WiJxmDi11uDJFbKJoObaUM6c",
  authDomain: "prenews-a91ae.firebaseapp.com",
  projectId: "prenews-a91ae",
  storageBucket: "prenews-a91ae.firebasestorage.app",
  messagingSenderId: "732063775829",
  appId: "1:732063775829:web:3ada686ffeb3ca37e0a8dc",
  measurementId: "G-8J1F6ZL3FM"
};
const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);