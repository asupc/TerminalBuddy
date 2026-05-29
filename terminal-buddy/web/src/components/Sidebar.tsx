import React from 'react';
import ProfileList from './ProfileList';

const Sidebar: React.FC = () => {
  return (
    <div style={{
      height: '100%', display: 'flex', flexDirection: 'column',
      background: '#16162e', borderRight: '1px solid #2a2a4a',
    }}>
      <div style={{
        padding: '8px 12px', borderBottom: '1px solid #2a2a4a',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      }}>
        <h2 style={{ fontSize: 13, color: '#a0a0d0' }}>连接</h2>
      </div>
      <ProfileList />
    </div>
  );
};

export default Sidebar;
