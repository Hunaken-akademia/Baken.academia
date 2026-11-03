'use client';
import {useEffect,useState} from 'react';
import {createClient} from '@/lib/supabase/client';
import ReinSupportChatBox from './rein-support-chat-box';
export function ReinSupportChat(){
 const [email,setEmail]=useState('');
 useEffect(()=>{let live=true;let generation=0;const load=async()=>{const gen=++generation;try{const r=await fetch('/api/support-chat?mode=inbox',{cache:'no-store'});const d=await r.json();if(live&&gen===generation)setEmail(r.ok&&d.ok?d.email:'');}catch{if(live&&gen===generation)setEmail('');}};void load();const {data}=createClient().auth.onAuthStateChange((event,session)=>{if(event==='SIGNED_OUT'){++generation;setEmail('');}else if(event==='SIGNED_IN'){setEmail(previous=>previous===session?.user.email?.toLowerCase()?previous:'');void load();}});return()=>{live=false;++generation;data.subscription.unsubscribe();};},[]);
 if(!email)return null;
 return <div className="mx-auto w-full max-w-[1600px] px-3 pt-3 sm:px-6"><ReinSupportChatBox token="cookie-session" email={email} theme="dark"/></div>;
}
