import {redirect} from 'next/navigation';
import {createClient} from '@/lib/supabase/server';
import {hasActiveReinAccess,type ReinMembership} from '@/lib/rein-access';
import {ReinDictionary} from '@/components/rein-dictionary';
export const dynamic='force-dynamic';
export const metadata={title:'REIN辞典 | 馬・騎手・厩舎・重賞の条件別成績'};
export default async function DictionaryPage({searchParams}:{searchParams:Promise<{area?:string;kind?:string;q?:string}>}){
 const supabase=await createClient();const {data:claims}=await supabase.auth.getClaims();if(!claims?.claims?.sub)redirect('/login');
 const {data}=await supabase.from('rein_memberships').select('plan,status,access_starts_at,access_ends_at').maybeSingle();const membership=data as ReinMembership|null;if(!hasActiveReinAccess(membership))redirect('/access');
 const params=await searchParams;
 return <ReinDictionary plan={membership!.plan} initialArea={params.area} initialKind={params.kind} initialQuery={params.q?.slice(0,100)??''}/>;
}
