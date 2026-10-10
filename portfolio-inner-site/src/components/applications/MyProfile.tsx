import React, { useState } from 'react';
import { currentUserId } from '../../api';
import Window from '../os/Window';
import CandidateProfile from './CandidateProfile';
import ProfileVisibility from './ProfileVisibility';
import { CandidateInvitationsProps } from './CandidateInvitations';
import './GradeTasks.css';

const MyProfile: React.FC<CandidateInvitationsProps> = props => {
    const [userId] = useState(currentUserId);
    const [size] = useState(() => ({ width: Math.max(520, Math.min(1100, window.innerWidth - 60)),
        height: Math.max(430, Math.min(850, window.innerHeight - 50)) }));
    return <Window top={24} left={30} width={size.width} height={size.height} windowTitle={props.title}
        windowBarImage={props.image} windowBarIcon="windowExplorerIcon" closeWindow={props.onClose}
        onInteract={props.onInteract} minimizeWindow={props.onMinimize} bottomLeftText="Мой профиль · PDF">
        <div className="grade-tasks">
            {userId ? <>
                <ProfileVisibility userId={userId} />
                <CandidateProfile self embedded userId={userId} applicantId={userId} onClose={props.onClose} />
            </> : <p role="alert">Войдите в ITinder, чтобы открыть свой профиль.</p>}
        </div>
    </Window>;
};
export default MyProfile;
