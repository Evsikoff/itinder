import React from 'react';

interface BackIconProps {
    size?: number;
    style?: React.CSSProperties;
}

const BackIcon: React.FC<BackIconProps> = ({ size = 24, style }) => {
    return (
        <svg
            width={size}
            height={size}
            viewBox="0 0 24 24"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
            style={style}
        >
            <rect x="3" y="11" width="12" height="2" fill="black" />
            <rect x="3" y="9" width="2" height="6" fill="black" />
            <rect x="3" y="9" width="6" height="2" fill="black" />
            <rect x="3" y="13" width="6" height="2" fill="black" />
        </svg>
    );
};

export default BackIcon;
