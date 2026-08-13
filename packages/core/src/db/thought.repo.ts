import type { LocalDatabase } from '../platform/database.js';
import { clampInteger, newId, nowIso, queryOne } from './database.js';

export type ThoughtKind='inner_monologue'|'decision_summary';
export type ThoughtVisibility='user'|'admin';
export type ThoughtStatus='generating'|'completed'|'cancelled'|'failed';
interface ThoughtRow{id:string;message_id:string;batch_id:string;revision:number;kind:ThoughtKind;text:string;visibility:ThoughtVisibility;status:ThoughtStatus;created_at:string;}
export interface VisibleThought{id:string;messageId:string;batchId:string;revision:number;kind:ThoughtKind;text:string;visibility:ThoughtVisibility;status:ThoughtStatus;createdAt:string;}
export interface ThoughtCreateInput{messageId:string;batchId:string;revision:number;kind:ThoughtKind;visibility:ThoughtVisibility;}
export class ThoughtRepo{
  constructor(private readonly db:LocalDatabase,private readonly now:()=>Date=()=>new Date()){}
  async create(input:ThoughtCreateInput):Promise<VisibleThought>{const row:ThoughtRow={id:newId('thought'),message_id:input.messageId,batch_id:input.batchId,revision:input.revision,kind:input.kind,text:'',visibility:input.visibility,status:'generating',created_at:nowIso(this.now)};await this.db.run('INSERT INTO visible_thoughts(id,message_id,batch_id,revision,kind,text,visibility,status,created_at) VALUES(?,?,?,?,?,?,?,?,?)',[row.id,row.message_id,row.batch_id,row.revision,row.kind,row.text,row.visibility,row.status,row.created_at]);return toThought(row);}
  async get(id:string):Promise<VisibleThought|undefined>{const row=await queryOne<ThoughtRow>(this.db,'SELECT * FROM visible_thoughts WHERE id=?',[id]);return row?toThought(row):undefined;}
  async getUserThought(messageId:string):Promise<VisibleThought|undefined>{const row=await queryOne<ThoughtRow>(this.db,"SELECT * FROM visible_thoughts WHERE message_id=? AND kind='inner_monologue' AND visibility='user' AND status='completed' ORDER BY created_at DESC LIMIT 1",[messageId]);return row?toThought(row):undefined;}
  async getByBatchRevision(batchId:string,revision:number):Promise<VisibleThought|undefined>{const row=await queryOne<ThoughtRow>(this.db,'SELECT * FROM visible_thoughts WHERE batch_id=? AND revision=? ORDER BY created_at DESC LIMIT 1',[batchId,revision]);return row?toThought(row):undefined;}
  async getByMessage(messageId:string):Promise<VisibleThought[]>{return(await this.db.query<ThoughtRow>('SELECT * FROM visible_thoughts WHERE message_id=? ORDER BY created_at',[messageId])).map(toThought);}
  async listAdmin(options:{batchId?:string;revision?:number;limit?:number}={}):Promise<VisibleThought[]>{const limit=clampInteger(options.limit??100,1,500);let rows:ThoughtRow[];if(options.batchId!==undefined)rows=options.revision!==undefined?await this.db.query('SELECT * FROM visible_thoughts WHERE batch_id=? AND revision=? ORDER BY created_at DESC LIMIT ?',[options.batchId,options.revision,limit]):await this.db.query('SELECT * FROM visible_thoughts WHERE batch_id=? ORDER BY created_at DESC LIMIT ?',[options.batchId,limit]);else rows=await this.db.query('SELECT * FROM visible_thoughts ORDER BY created_at DESC LIMIT ?',[limit]);return rows.map(toThought);}
  async completeThought(id:string,text:string):Promise<boolean>{return(await this.db.run("UPDATE visible_thoughts SET status='completed',text=? WHERE id=? AND status='generating'",[text.slice(0,2000),id])).changes===1;}
  async failThought(id:string):Promise<boolean>{return(await this.db.run("UPDATE visible_thoughts SET status='failed',text='' WHERE id=? AND status='generating'",[id])).changes===1;}
  async cancelThought(id:string):Promise<boolean>{return(await this.db.run("UPDATE visible_thoughts SET status='cancelled',text='' WHERE id=? AND status='generating'",[id])).changes===1;}
  async cancelOpenThoughts(batchId?:string):Promise<number>{return(await this.db.run(batchId===undefined?"UPDATE visible_thoughts SET status='cancelled',text='' WHERE status='generating'":"UPDATE visible_thoughts SET status='cancelled',text='' WHERE status='generating' AND batch_id=?",batchId===undefined?[]:[batchId])).changes;}
  async countGenerating():Promise<number>{return(await queryOne<{c:number}>(this.db,"SELECT COUNT(*) c FROM visible_thoughts WHERE status='generating'"))?.c??0;}
}
function toThought(row:ThoughtRow):VisibleThought{return{id:row.id,messageId:row.message_id,batchId:row.batch_id,revision:row.revision,kind:row.kind,text:row.text,visibility:row.visibility,status:row.status,createdAt:row.created_at};}
