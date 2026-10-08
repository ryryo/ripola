import ripolaLogo from '../assets/ripola-logo.png';

export function Brand() {
  return <a href={import.meta.env.BASE_URL} className="brand brand-lockup" aria-label="Ripola ホーム"><img src={ripolaLogo} alt="" /></a>;
}
