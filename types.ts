export interface Project {
  id: number;
  name: string;
  description: string;
  created_at: string;
}

export interface FileMetadata {
  id: number;
  project_id: number;
  name: string;
  path: string;
  last_modified: string;
}

export interface WorkLog {
  id: number;
  project_id: number;
  project_name: string;
  activity: string;
  timestamp: string;
}

export interface Message {
  role: 'user' | 'model';
  content: string;
}
