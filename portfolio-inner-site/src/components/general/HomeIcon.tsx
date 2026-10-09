import React from 'react';

interface HomeIconProps {
    size?: number;
    style?: React.CSSProperties;
}

const HomeIcon: React.FC<HomeIconProps> = ({ size = 24, style }) => {
    return (
        <svg
            width={size}
            height={size}
            viewBox="0 0 24 24"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
            style={style}
        >
            {/* Пиксельный домик в стиле Windows 95 */}
            <rect x="3" y="10" width="18" height="12" fill="black" />
            <rect x="4" y="11" width="16" height="10" fill="white" />
            <rect x="5" y="12" width="6" height="5" fill="black" />
            <rect x="13" y="12" width="6" height="5" fill="black" />
            <polygon points="12,3 3,10 4,10 12,4 20,10 21,10" fill="black" />
            <rect x="10" y="15" width="4" height="6" fill="black" />
            <rect x="11" y="16" width="2" height="4" fill="#C0C0C0" />
        </svg>
    );
};

export default HomeIcon;
